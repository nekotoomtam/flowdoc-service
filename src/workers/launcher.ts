import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,readlink,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import type {Writable,Readable} from 'node:stream';
import {BrokerClient,encodeFrame} from './broker-client.js';
import {loadWorkerAnchor,workerEnvironment,type WorkerConfig} from './config.js';
import {WORKER_KINDS,workerError,type WorkerKind,type WorkerState,type WorkerLauncher,type BlockedWorker,type BoundProof,type StoppedProof,type ApprovedLaunchSpec} from './contracts.js';

interface Payload {executable:string;args:string[]}
/** Trusted composition/test seam only; never expose payload resolution to HTTP/input. */
interface Dependencies {resolvePayload?:(kind:WorkerKind,spec:ApprovedLaunchSpec)=>Payload;spawnChild?:typeof spawn;onGateEvent?:(event:Record<string,unknown>)=>void;readChildStart?:(pid:number)=>Promise<string>}
const root=fileURLToPath(new URL('../../',import.meta.url));
const startTime=async(pid:number)=>{const s=await readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+1).trim().split(/\s+/)[19]!;};
async function membership(pid:number){const s=(await readFile('/proc/'+pid+'/cgroup','utf8')).trim();if(!s.startsWith('0::'))throw workerError('WORKER_BIND_INVALID');return s.slice(3);}
async function groupGone(pgid:number){
 for(const id of await readdir('/proc'))if(/^\d+$/.test(id))try{const s=await readFile('/proc/'+id+'/stat','utf8'),fields=s.slice(s.lastIndexOf(')')+1).trim().split(/\s+/);if(Number(fields[2])===pgid)return false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 return true;
}
function defaultPayload(kind:WorkerKind,s:ApprovedLaunchSpec,python:string):Payload{
 if(kind==='legacy-render'||kind==='font-preflight')return {executable:process.execPath,args:[root+'dist/jobs/render-child.js']};
 if(kind==='image-prepare')return {executable:process.execPath,args:[root+'dist/images/worker.js']};
 if(kind==='task-render')return {executable:python,args:[root+'runtime/python/task_launcher.py',String(s.fileBytes),process.execPath,root+'dist/tasks/render-child.js']};
 return {executable:python,args:[root+'runtime/python/inspectFont.py',s.fontPath!,...(s.includeHeightMetric?['--height-metric']:[])]};
}
function validateSpec(s:ApprovedLaunchSpec){
 const allowed=['kind','deadlineAt','signal','env','fenceFd','fileBytes','fontPath','includeHeightMetric'];
 if(!s||Object.keys(s).some(k=>!allowed.includes(k))||!WORKER_KINDS.includes(s.kind)||!Number.isSafeInteger(s.deadlineAt)||s.deadlineAt<=Date.now()||s.deadlineAt-Date.now()>10800000)throw workerError('WORKER_LAUNCH_INVALID');
 if(s.kind==='task-render'&&(!Number.isSafeInteger(s.fileBytes)||s.fileBytes!<1||!Number.isInteger(s.fenceFd)||s.fenceFd!<0))throw workerError('WORKER_LAUNCH_INVALID');
 if(s.kind==='font-inspect'&&(typeof s.fontPath!=='string'||!s.fontPath.startsWith('/')||s.fontPath.length>4096||s.fontPath.includes('\0')))throw workerError('WORKER_LAUNCH_INVALID');
}
export async function createWorkerLauncher(config:WorkerConfig,deps:Dependencies={}):Promise<WorkerLauncher>{
 if(config.mode!=='required')throw workerError('WORKER_ISOLATION_DISABLED');
 if(process.platform!=='linux')throw workerError('WORKER_BROKER_UNAVAILABLE');
 let anchor:Awaited<ReturnType<typeof loadWorkerAnchor>>,broker:BrokerClient;
 try{
  anchor=await loadWorkerAnchor(config);
  if(anchor.coordinatorPid!==process.pid||anchor.coordinatorStart!==await startTime(process.pid)||anchor.pidNamespace!==await readlink('/proc/self/ns/pid')||anchor.serviceUid!==process.getuid!()||Number((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim())!==config.aggregateBytes)throw Error('anchor mismatch');
  broker=await BrokerClient.connect(config.socketPath,anchor,config.rpcMs);
 }catch{throw workerError('WORKER_BROKER_UNAVAILABLE');}
 let ready=true,admissions=true,sequence=0,launching=0,unconfirmed=false;const workers=new Set<BlockedWorker>(),gateClosers=new Set<()=>void>(),drainers=new Set<()=>void>();
 broker.onLost(()=>{ready=false;for(const f of gateClosers)f();for(const h of workers)void h.stop('broker lost').catch(()=>{});});
 const launcher:WorkerLauncher={
  isReady:()=>ready&&admissions&&broker.isReady(),
  closeAdmissions(){admissions=false;},
  async drain(){admissions=false;while(launching)await new Promise<void>(resolve=>drainers.add(resolve));const results=await Promise.allSettled([...workers].map(h=>h.stop('drain')));if(unconfirmed||results.some(r=>r.status==='rejected'))throw workerError('WORKER_STOP_UNCONFIRMED');broker.close();},
  async spawnBlocked(spec){
   validateSpec(spec);spec={...spec,...(spec.env?{env:{...spec.env}}:{})};spec.signal?.throwIfAborted();const env=workerEnvironment(spec.env);
   const rawPayload=(deps.resolvePayload??((k,s)=>defaultPayload(k,s,config.python)))(spec.kind,spec),payload={executable:rawPayload.executable,args:[...rawPayload.args]};
   if(!payload.executable.startsWith('/')||payload.executable.includes('\0')||payload.args.length>16||payload.args.some(x=>typeof x!=='string'||x.length>4096||x.includes('\0')))throw workerError('WORKER_LAUNCH_INVALID');
   if(!launcher.isReady())throw workerError('WORKER_BROKER_UNAVAILABLE');
   launching++;
   try{
   const seq=++sequence,nonce=randomBytes(16).toString('hex');
   const arm=await broker.call('ARM',{sequence:seq,nonce,kind:spec.kind,remainingMs:Math.max(1,spec.deadlineAt-Date.now())});
   if(arm.state!=='armed'||typeof arm.group!=='string'||!/^worker-[a-f0-9]{32}$/.test(arm.group))throw workerError('WORKER_BIND_INVALID');
   if(!launcher.isReady()){
    try{await broker.call('CANCEL',{sequence:seq});const r=await broker.call('WAIT_EMPTY',{sequence:seq});if(r.empty!==true)throw Error();}
    catch{ready=false;unconfirmed=true;throw workerError('WORKER_STOP_UNCONFIRMED');}throw workerError('WORKER_BROKER_UNAVAILABLE');
   }
   let state:WorkerState='blocked',closed=false,spawnError:Error|undefined,statusText='',boundValue:Record<string,unknown>|undefined,statusFailure=false,statusEnded=false;
   const listeners=new Set<()=>void>();const notify=()=>{for(const f of listeners)f();};
   const ipc=spec.kind==='task-render'||spec.kind==='image-prepare';const fence=spec.kind==='task-render';
   let child:ChildProcess;
   try{child=(deps.spawnChild??spawn)(config.python,['-I','-S',root+'runtime/python/worker_gate.py'],{env,detached:true,stdio:['pipe','pipe','ignore',ipc?'ipc':'ignore',fence?spec.fenceFd!:'ignore','pipe','pipe'],serialization:spec.kind==='task-render'?'advanced':'json'});}
   catch{
    await broker.call('CANCEL',{sequence:seq});await broker.call('WAIT_EMPTY',{sequence:seq});throw workerError('WORKER_SPAWN_FAILED');
   }
   const streams:ReadonlyArray<NodeJS.ReadableStream|NodeJS.WritableStream|null|undefined>=child.stdio;
   const input=streams[5]as Writable,status=streams[6]as Readable|undefined;
   input?.on('error',()=>{statusFailure=true;notify();});status?.on('error',()=>{statusFailure=true;notify();});child.stdin?.on('error',()=>{statusFailure=true;notify();});
   const closeGate=()=>{if(input&&!input.writableEnded)input.end();};gateClosers.add(closeGate);
   status?.once('end',()=>{statusEnded=true;notify();});
   child.once('error',e=>{spawnError=e;notify();});child.once('close',()=>{closed=true;notify();});
   status?.on('data',(chunk:Buffer)=>{
    if(statusFailure)return;
    statusText+=chunk.toString('utf8');if(statusText.length>8192){statusFailure=true;notify();return;}
    for(let index;(index=statusText.indexOf('\n'))>=0;){const line=statusText.slice(0,index);statusText=statusText.slice(index+1);try{
     const m=JSON.parse(line);deps.onGateEvent?.(m);if(m.event==='bound')boundValue=m;else if(m.event==='failed')statusFailure=true;else if(!['blocked','exec'].includes(m.event))statusFailure=true;
    }catch{statusFailure=true;}notify();}
   });
   // Guard the existing transport surface; private gate FD5 is separate.
   if(child.stdin){const write=child.stdin.write.bind(child.stdin),end=child.stdin.end.bind(child.stdin);child.stdin.write=((...args:unknown[])=>{if(state!=='started')throw workerError('WORKER_NOT_STARTED');return(write as Function)(...args);})as typeof child.stdin.write;child.stdin.end=((...args:unknown[])=>{if(state!=='started')throw workerError('WORKER_NOT_STARTED');return(end as Function)(...args);})as typeof child.stdin.end;}
   if(child.send){const send=child.send.bind(child);child.send=((...args:unknown[])=>{if(state!=='started')throw workerError('WORKER_NOT_STARTED');return(send as Function)(...args);})as typeof child.send;}
   const wait=async(check:()=>boolean,until:number,allowClosed=false)=>{
    while(!check()){
     if(!allowClosed&&(spawnError||statusFailure||closed))throw workerError('WORKER_GATE_FAILED');
     if(Date.now()>=until)throw workerError('WORKER_DEADLINE');
     await new Promise<void>(resolve=>{const timer=setTimeout(done,20);function done(){clearTimeout(timer);listeners.delete(done);resolve();}listeners.add(done);});
    }
   };
   let identity:{pid:number;pgid:number;startTime:string};
   try{await wait(()=>child.pid!==undefined,Math.min(spec.deadlineAt,Date.now()+config.rpcMs));const pid=child.pid!;identity=Object.freeze({pid,pgid:pid,startTime:await(deps.readChildStart??startTime)(pid)});}
   catch{
    input?.end();try{await broker.call('CANCEL',{sequence:seq});await wait(()=>closed,Date.now()+config.stopMs,true);const r=await broker.call('WAIT_EMPTY',{sequence:seq});if(r.empty!==true||(child.pid&&!await groupGone(child.pid)))throw Error();}
    catch{ready=false;unconfirmed=true;throw workerError('WORKER_STOP_UNCONFIRMED');}gateClosers.delete(closeGate);throw workerError('WORKER_SPAWN_FAILED');
   }
   let binding:Promise<BoundProof>|undefined,starting:Promise<void>|undefined,stopping:Promise<StoppedProof>|undefined;
   let timeout:NodeJS.Timeout;const abort=()=>{void handle.stop('abort').catch(()=>{});};
   const handle:BlockedWorker={child,identity,get state(){return state;},
    bind(){
     if(state==='stopping'||state==='stopped')return Promise.reject(workerError('WORKER_STATE_INVALID'));if(binding)return binding;if(state!=='blocked')return Promise.reject(workerError('WORKER_STATE_INVALID'));
     binding=(async()=>{
      state='binding';
      input.write(encodeFrame({v:1,socketPath:config.socketPath,epoch:broker.sessionEpoch,sequence:seq,nonce,namespaceRoot:anchor.namespaceRoot,pidNamespace:anchor.pidNamespace,remainingMs:Math.max(1,spec.deadlineAt-Date.now()),payload:{...payload,env,ipc,fence}}));
      await wait(()=>boundValue!==undefined,Math.min(spec.deadlineAt,Date.now()+config.rpcMs));
      const b=boundValue!;if(state!=='binding'||b.pid!==identity.pid||b.startTime!==identity.startTime||b.epoch!==broker.sessionEpoch||b.sequence!==seq||b.group!==arm.group)throw workerError('WORKER_BIND_INVALID');
      const path=anchor.namespaceRoot+'/'+b.group;
      if(await startTime(identity.pid)!==identity.startTime||await membership(identity.pid)!==path||Number((await readFile('/sys/fs/cgroup'+path+'/memory.max','utf8')).trim())!==536870912||Number((await readFile('/sys/fs/cgroup'+path+'/memory.swap.max','utf8')).trim())!==0)throw workerError('WORKER_BIND_INVALID');
      if(state!=='binding')throw workerError('WORKER_STATE_INVALID');state='bound';return Object.freeze({epoch:broker.sessionEpoch,sequence:seq,group:arm.group as string,pid:identity.pid,startTime:identity.startTime,memoryMax:536870912 as const,swapMax:0 as const});
     })().catch(async e=>{if(e?.code==='WORKER_BIND_INVALID')ready=false;await handle.stop('bind failure');throw workerError(typeof e?.code==='string'&&e.code.startsWith('WORKER_')?e.code:'WORKER_BIND_INVALID');});return binding;
    },
    start(){
     if(state==='stopping'||state==='stopped')return Promise.reject(workerError('WORKER_STATE_INVALID'));if(starting)return starting;if(state!=='bound')return Promise.reject(workerError('WORKER_STATE_INVALID'));
     starting=(async()=>{state='starting';await broker.call('COMMIT',{sequence:seq});if(state!=='starting')throw workerError('WORKER_STATE_INVALID');input.write(encodeFrame({v:1,op:'GO'}));
      const end=Math.min(spec.deadlineAt,Date.now()+config.rpcMs),expected=!deps.resolvePayload&&spec.kind==='task-render'?process.execPath:payload.executable;
      while(true){if(closed||statusFailure)throw workerError('WORKER_GATE_FAILED');if(statusEnded&&await readlink('/proc/'+identity.pid+'/exe')===expected)break;if(Date.now()>end)throw workerError('WORKER_DEADLINE');await new Promise(r=>setTimeout(r,5));}
      if(state!=='starting')throw workerError('WORKER_STATE_INVALID');state='started';
     })().catch(async e=>{await handle.stop('start failure');throw workerError(typeof e?.code==='string'&&e.code.startsWith('WORKER_')?e.code:'WORKER_GATE_FAILED');});return starting;
    },
    stop(_reason){
     if(stopping)return stopping;state='stopping';clearTimeout(timeout);spec.signal?.removeEventListener('abort',abort);input.end();
     stopping=(async()=>{
      try{
       await broker.call('CANCEL',{sequence:seq});const end=Date.now()+config.stopMs;
       await wait(()=>closed,end,true);
       while(true){const r=await broker.call('WAIT_EMPTY',{sequence:seq});if(r.empty===true&&await groupGone(identity.pgid))break;if(Date.now()>end)throw Error('stop deadline');await new Promise(r=>setTimeout(r,20));}
       state='stopped';workers.delete(handle);gateClosers.delete(closeGate);return Object.freeze({childReaped:true as const,groupGone:true as const,scopeEmpty:true as const});
      }catch{ready=false;unconfirmed=true;throw workerError('WORKER_STOP_UNCONFIRMED');}
     })();return stopping;
    },
    async waitStopped(){await wait(()=>closed,spec.deadlineAt+config.stopMs,true);return handle.stop('completion');}
   };
   timeout=setTimeout(abort,Math.max(1,spec.deadlineAt-Date.now()));timeout.unref();workers.add(handle);spec.signal?.addEventListener('abort',abort,{once:true});if(spec.signal?.aborted)abort();return handle;
   }finally{launching--;for(const f of drainers)f();drainers.clear();}
  }
 };
 return launcher;
}
