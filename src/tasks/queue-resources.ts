import {readFile} from 'node:fs/promises';
import {taskError} from './quota.js';
import {performance} from 'node:perf_hooks';
import {channel} from 'node:diagnostics_channel';
import {DEFAULT_QUEUE_PROFILE,parseQueueCpuLimit,type QueueProfile} from './queue-profile.js';
const MiB=1048576;
export type MemorySample={current:number;max:number;peak?:number;stat?:Record<string,number>;events?:Record<string,number>};
export interface QueueResourceOptions {readMemory?:()=>Promise<MemorySample>;sampleMs?:number;profile?:QueueProfile;readCpuLimit?:()=>Promise<number|null>}
type Kind='intake'|'worker'|'sender';
type Request={kind:Kind;order:number;expiresAt:number;signal?:AbortSignal;onStop?:(code:string)=>void};
type Grant={release:()=>void};
type Waiter={id:string;request:Request;resolve:(g:Grant)=>void;reject:(e:unknown)=>void;abort:()=>void};
export async function readQueueMemory():Promise<MemorySample>{
 if(process.platform!=='linux')throw taskError('UNAVAILABLE');
 const [current,max,statText,eventsText,peak]=await Promise.all(['memory.current','memory.max','memory.stat','memory.events','memory.peak'].map(name=>readFile('/sys/fs/cgroup/'+name,'utf8')));
 if(current===undefined||max===undefined||statText===undefined||eventsText===undefined||peak===undefined)throw taskError('UNAVAILABLE');
 const counters=(text:string)=>Object.fromEntries(text.trim().split('\n').map(line=>{const[k,v]=line.trim().split(/\s+/);if(!k||!Number.isSafeInteger(Number(v))||Number(v)<0)throw taskError('UNAVAILABLE');return[k,Number(v)];}));
 const stat=counters(statText),events=counters(eventsText);if(!['anon','file','kernel'].every(k=>Number.isSafeInteger(stat[k]))||!['oom','oom_kill'].every(k=>Number.isSafeInteger(events[k]))||!Number.isSafeInteger(Number(peak.trim())))throw taskError('UNAVAILABLE');
 return {current:Number(current.trim()),max:Number(max.trim()),peak:Number(peak.trim()),stat,events};
}
/** One coordinator owns these ephemeral grants; task admission remains transactional in PostgreSQL. */
export async function createQueueResources(options:QueueResourceOptions={}){
 const profile=options.profile??DEFAULT_QUEUE_PROFILE;
 if(profile.strict){let cpus:number|null=null;try{cpus=await(options.readCpuLimit??(async()=>parseQueueCpuLimit(await readFile('/sys/fs/cgroup/cpu.max','utf8'))))();}catch{}if(cpus!==profile.cpuCount)throw taskError('UNAVAILABLE');}
 const read=options.readMemory??readQueueMemory,interval=options.sampleMs??100;
 if(!Number.isInteger(interval)||interval<1||interval>100)throw taskError('INVALID_REQUEST');
 const cost:Record<Kind,number>={intake:64,worker:320,sender:8},limit:Record<Kind,number>={intake:2,worker:2,sender:2};
 const active=new Map<string,{request:Request;sequence:number;stopping:boolean}>(),waiting:Waiter[]=[];
 let sample:MemorySample|undefined,sampledAt=0,faultSince:number|undefined,closed=false,busy=false,pressure=false,low=0,emergency=0,sequence=0,enabled=false;
 const credits=()=>128+[...active.values()].reduce((n,a)=>n+cost[a.request.kind],0);
 let startupEnabled=false;
 const histogram=()=>{const buckets=Array<number>(9).fill(0);let count=0,max=0,total=0;return{add(v:number){count++;max=Math.max(max,v);total+=v;const i=[1,5,10,25,50,100,250,500].findIndex(n=>v<=n);buckets[i<0?8:i]!++;},snapshot:()=>({count,max,total,buckets:[...buckets]})};};
 const readMs=histogram(),scheduleLagMs=histogram(),sampleAgeMs=histogram();let readErrors=0,readTimeouts=0,staleStops=0,lastFailure:string|null=null,nextTick=performance.now(),sampleMono=0,staleNotified=false,inFlight:Promise<MemorySample>|undefined;
 const timing=()=>({readMs:readMs.snapshot(),scheduleLagMs:scheduleLagMs.snapshot(),sampleAgeMs:sampleAgeMs.snapshot(),readErrors,readTimeouts,staleStops,lastFailure,sampleAgeMsNow:sample?performance.now()-sampleMono:null});
 const healthy=()=>startupEnabled&&!closed&&!!sample&&faultSince===undefined&&performance.now()-sampleMono<=500;
 const counts=(kind:Kind)=>[...active.values()].filter(a=>a.request.kind===kind).length;
 const reject=(w:Waiter,error:unknown)=>{const at=waiting.indexOf(w);if(at>=0)waiting.splice(at,1);w.request.signal?.removeEventListener('abort',w.abort);w.reject(error);};
 function stopActive(code:string,all=false){
  if(!all&&[...active.values()].some(a=>a.stopping))return;
  const rank:Record<Kind,number>={worker:0,intake:1,sender:2};
  const candidates=[...active.values()].filter(a=>!a.stopping).sort((a,b)=>rank[a.request.kind]-rank[b.request.kind]||b.sequence-a.sequence);
  for(const a of all?candidates:candidates.slice(0,1)){a.stopping=true;a.request.onStop?.(code);}
 }
 function checkFreshness(){
  if(!startupEnabled||closed||!sample||performance.now()-sampleMono<500)return;
  faultSince??=sampleMono;
  if(!staleNotified){staleNotified=true;staleStops++;lastFailure=inFlight?'read_pending':'sample_stale';}
  for(const w of [...waiting])reject(w,taskError('UNAVAILABLE'));stopActive('UNAVAILABLE',true);
 }
 function drain(){
  for(const w of [...waiting])if(w.request.expiresAt<=Date.now())reject(w,taskError('TASK_EXPIRED'));
  if(!healthy()||pressure||[...active.values()].some(a=>a.stopping))return;
  waiting.sort((a,b)=>a.request.order-b.request.order||a.id.localeCompare(b.id));
  // FIFO per stage, without a later request bypassing the head of its own stage.
  const blocked=new Set<Kind>();
  for(const w of [...waiting]){
   const k=w.request.kind;if(blocked.has(k))continue;
   if(counts(k)>=limit[k]||Math.max(sample!.current/MiB,credits())+cost[k]>profile.admissionMiB){blocked.add(k);continue;}
   waiting.splice(waiting.indexOf(w),1);w.request.signal?.removeEventListener('abort',w.abort);
   active.set(w.id,{request:w.request,sequence:++sequence,stopping:false});let released=false;
   w.resolve({release(){if(released)return;released=true;active.delete(w.id);drain();}});
  }
 }
 async function tick(){
  checkFreshness();if(closed||busy||inFlight)return;busy=true;
  const started=performance.now(),lag=Math.max(0,started-nextTick);scheduleLagMs.add(lag);nextTick=started+interval;
  if(sample)sampleAgeMs.add(started-sampleMono);
  let failure='read_error';
  try{
   let timeout:NodeJS.Timeout|undefined;let v:MemorySample;
   inFlight=Promise.resolve().then(read).then(v=>{inFlight=undefined;return v;},e=>{inFlight=undefined;throw e;});
   try{v=await Promise.race([inFlight,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{readTimeouts++;failure='read_timeout';reject(taskError('UNAVAILABLE'));},500);})]);}finally{clearTimeout(timeout);readMs.add(performance.now()-started);}
   // A delayed callback must not turn an old reading into a fresh one.
   checkFreshness();if(performance.now()-started>500){failure='read_late';throw taskError('UNAVAILABLE');}
   if(!Number.isSafeInteger(v.current)||v.current<0||v.max!==profile.memoryBytes){failure='invalid_sample';throw taskError('UNAVAILABLE');}
   sample=v;sampledAt=Date.now();sampleMono=performance.now();faultSince=undefined;staleNotified=false;enabled=true;
   if(v.current>=profile.pressureMiB*MiB){pressure=true;low=0;}
   else if(pressure){low=v.current<=profile.resumeMiB*MiB?low+1:0;if(low>=10){pressure=false;low=0;}}
   emergency=v.current>=profile.emergencyMiB*MiB?emergency+1:0;if(emergency>=3)stopActive('RESOURCE_LIMIT');
  }catch{
   readErrors++;lastFailure=failure;
   faultSince??=sample?sampleMono:started;if(performance.now()-faultSince>=500){for(const w of [...waiting])reject(w,taskError('UNAVAILABLE'));stopActive('UNAVAILABLE',true);}
  }finally{busy=false;channel('flowdoc.task.queue.memory').publish({at:Date.now(),scheduleLagMs:lag,readMs:performance.now()-started,sampleAgeMs:sample?performance.now()-sampleMono:null,lastFailure,intakes:counts('intake'),workers:counts('worker'),senders:counts('sender')});drain();}
 }
 await tick();startupEnabled=enabled;if(profile.strict&&!startupEnabled)throw taskError('UNAVAILABLE');const timer=setInterval(()=>{void tick();},interval);timer.unref();
 return {
  memoryLimits:Object.freeze({pauseBytes:profile.admissionMiB*MiB,stopBytes:profile.emergencyMiB*MiB}),
  enabled:()=>startupEnabled,
  ready:healthy,
  holds:(id:string,kind:Kind)=>active.get(id)?.request.kind===kind,
  tryAcquire(id:string,request:Request):Grant|null{
   if(!healthy())throw taskError('UNAVAILABLE');
   if(request.signal?.aborted)throw request.signal.reason??taskError('WORKER_INTERRUPTED');
   if(request.expiresAt<=Date.now())throw taskError('TASK_EXPIRED');
   if(active.has(id)||waiting.some(w=>w.id===id))throw taskError('TASK_REQUEST_CONFLICT');
   if(pressure||[...active.values()].some(a=>a.stopping)||waiting.some(w=>w.request.kind===request.kind)||counts(request.kind)>=limit[request.kind]||Math.max(sample!.current/MiB,credits())+cost[request.kind]>profile.admissionMiB)return null;
   active.set(id,{request,sequence:++sequence,stopping:false});let released=false;
   return {release(){if(released)return;released=true;active.delete(id);drain();}};
  },
  waitReason(kind:Kind){return counts(kind)>=limit[kind]?(kind==='worker'?'processing_slot':kind==='sender'?'send_slot':'receive_slot'):'memory';},
  acquire(id:string,request:Request):Promise<Grant>{
   if(!healthy())return Promise.reject(taskError('UNAVAILABLE'));
   if(request.signal?.aborted)return Promise.reject(request.signal.reason??taskError('CONNECTION_LOST'));
   if(request.expiresAt<=Date.now())return Promise.reject(taskError('TASK_EXPIRED'));
   if(active.has(id)||waiting.some(w=>w.id===id))return Promise.reject(taskError('TASK_REQUEST_CONFLICT'));
   if(waiting.length>=profile.maxOutstanding)return Promise.reject(taskError('QUEUE_FULL'));
   return new Promise((resolve,rejectPromise)=>{const w:Waiter={id,request,resolve,reject:rejectPromise,abort:()=>reject(w,request.signal?.reason??taskError('CONNECTION_LOST'))};waiting.push(w);request.signal?.addEventListener('abort',w.abort,{once:true});if(request.signal?.aborted)w.abort();else drain();});
  },
  snapshot:()=>({intakes:counts('intake'),workers:counts('worker'),senders:counts('sender'),waiters:waiting.length,creditsMiB:credits(),memoryBytes:sample?.current??null,memoryPeakBytes:sample?.peak??null,memoryStat:sample?.stat??null,memoryEvents:sample?.events??null,pressure,healthy:healthy(),timing:timing()}),
  async stop(){closed=true;clearInterval(timer);for(const w of [...waiting])reject(w,taskError('WORKER_INTERRUPTED'));stopActive('WORKER_INTERRUPTED',true);while(busy)await new Promise(r=>setTimeout(r,1));}
 };
}
