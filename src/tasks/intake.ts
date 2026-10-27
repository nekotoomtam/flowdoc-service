import {createReceiveIdle} from './receive-idle.js';
import {parseOutputFormat} from './output-format.js';
import type {Pool} from 'pg';import type {FileHandle} from 'node:fs/promises';import {Readable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {createHash,randomUUID} from 'node:crypto';import {hostname} from 'node:os';
import {Busboy} from '@fastify/busboy';import {transaction} from '../db/connection.js';import {loadTemplate} from '../templates/registry.js';
import {validJobId} from '../jobs/repository.js';import {taskFiles} from './files.js';import {policyWith,type TaskPolicy} from './policy.js';
import {quotaLock,taskError} from './quota.js';import {taskRepository,safeTask,terminal,type TaskIdentity} from './repository.js';
import {normalizeStoredTask} from './normalize.js';
import {workspaceSize,clearWorkspace,groupStopped,processIdentity} from './workspace.js';
import {inspectPayload} from './payload.js';import {headerBudget,taskBoundary} from './multipart.js';
import {createQueueResources,type QueueResourceOptions} from './queue-resources.js';
import {queuePolicy} from './policy.js';
import {DEFAULT_QUEUE_PROFILE,isQueuePolicyVersion,usesInputWaitBudget} from './queue-profile.js';
interface Dependencies{pool:Pool;root:string;resolveCredential:(header:string)=>TaskIdentity|null|Promise<TaskIdentity|null>;policy?:Partial<TaskPolicy>;queueResources?:QueueResourceOptions;freeBytes?:()=>Promise<number>;removeFile?:(path:string)=>Promise<void>;writeChunk?:(handle:FileHandle,chunk:Buffer)=>Promise<void>}
interface Opening{outputFormat?:unknown;authorization:string;docKey:unknown;contentType:string;contentEncoding?:string;queueMode?:boolean}
interface Receiving{authorization:string;taskId:string;contentType:string;body:Readable;signal?:AbortSignal}
export async function createTaskIntake(deps:Dependencies){
 const {pool}=deps,p=policyWith(deps.policy),profile=deps.queueResources?.profile??DEFAULT_QUEUE_PROFILE,files=await taskFiles(deps.root,deps.removeFile),repo=taskRepository(pool,p,deps.freeBytes??files.freeBytes,profile);
 const resources=await createQueueResources(deps.queueResources);
 const queued=new Map<string,{abort:AbortController;done:Promise<void>;stage:'waiting'|'receiving'|'validating'}>();
 const externalReason=(signal:AbortSignal|undefined)=>{const code=(signal?.reason as any)?.code;return taskError(typeof code==='string'&&['TASK_EXPIRED','WORKER_INTERRUPTED','RESOURCE_LIMIT','UNAVAILABLE','TASK_TIMEOUT'].includes(code)?code:'CONNECTION_LOST');};
 const active=new Map<string,{abort:AbortController;done:Promise<void>}>(),opened=new Set<string>();let closing=false,quarantined=false;
 async function authenticate(header:string){const i=await deps.resolveCredential(header);if(!i||!header.startsWith('Bearer ')||!i.ownerKey||!i.principalId||Buffer.byteLength(i.ownerKey)>200||Buffer.byteLength(i.principalId)>200||!Array.isArray(i.docKeys))throw taskError('UNAUTHORIZED');return i;}
 async function owned(header:string,id:string,write=false){const i=await authenticate(header);if(!validJobId(id))throw taskError('INVALID_REQUEST');const r=await repo.get(id);if(!r||r.owner_key!==i.ownerKey)throw taskError('TASK_NOT_FOUND');if(write?r.created_by_principal!==i.principalId:r.created_by_principal!==i.principalId&&!i.taskRead)throw taskError('FORBIDDEN');return {r,i};}
 const stopped=async(r:any)=>{if(!r.writer_pid)return true;if(r.writer_host!==hostname())return false;if(r.writer_start_identity&&await processIdentity(r.writer_pid)!==r.writer_start_identity)return true;try{process.kill(r.writer_pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}};
 async function cleanup(id:string){
  let r=await repo.get(id);if(!r)return;if(terminal(r.status))opened.delete(id);if(!terminal(r.status)||active.has(id)||queued.has(id)||!await stopped(r)||!await groupStopped(r.child_pid,r.child_host,hostname()))return;
  await pool.query("UPDATE tasks SET cleanup_status='running',updated_at=now() WHERE id=$1",[id]);
  let retry=false;const due=r.due,all=(await pool.query('SELECT * FROM task_files WHERE task_id=$1',[id])).rows;
  const keep=new Set(all.filter(f=>f.state==='received'&&['payload','original_image'].includes(f.role)&&!due&&r.status!=='succeeded').map(f=>f.storage_key));
  const names=await files.names(id);
  for(const key of names){if(keep.has(key))continue;try{await files.remove(key);await pool.query("UPDATE task_files SET state='deleted',storage_key=NULL,stored_bytes=0,deleted_at=clock_timestamp(),updated_at=now() WHERE task_id=$1 AND storage_key=$2",[id,key]);}catch{retry=true;}}
  const workspace=await files.workspace(id,false);
  try{await clearWorkspace(workspace);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')retry=true;}
  let actual=0;try{actual=await workspaceSize(workspace);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}for(const key of await files.names(id))actual+=await files.size(key);
  const outputs=(await pool.query('SELECT o.id,o.path FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1 AND o.deleted_at IS NULL',[id])).rows;
  for(const out of outputs){const name=out.path.split(/[\\/]/).at(-1);if(!await files.size(id+'/output/'+name))await pool.query("UPDATE document_outputs SET availability='expired',deleted_at=clock_timestamp() WHERE id=$1",[out.id]);}
  // A missing file also becomes a tombstone; file disappearance never implies send success.
  for(const f of all)if(f.storage_key&&!(await files.size(f.storage_key))&&!keep.has(f.storage_key))await pool.query("UPDATE task_files SET state='deleted',storage_key=NULL,stored_bytes=0,deleted_at=clock_timestamp(),updated_at=now() WHERE id=$1",[f.id]);
  if(!actual&&!retry)try{if(!await files.removeEmptyDirectories(id))retry=true;}catch{retry=true;}
  await transaction(pool,async c=>{await quotaLock(c);await repo.row(c,id);const q=(await c.query('SELECT storage_held_bytes FROM task_resource_reservations WHERE task_id=$1 FOR UPDATE',[id])).rows[0];
   if(actual>Number(q.storage_held_bytes))throw taskError('STORAGE_IO');
   await c.query('UPDATE task_resource_reservations SET storage_used_bytes=$2,storage_held_bytes=CASE WHEN $3 THEN storage_held_bytes ELSE $2 END,released_at=CASE WHEN $2=0 AND NOT $3 THEN clock_timestamp() ELSE NULL END,updated_at=now() WHERE task_id=$1',[id,actual,retry]);
   await c.query("UPDATE tasks SET cleanup_status=$2,cleanup_completed_at=CASE WHEN $2='done' THEN clock_timestamp() ELSE NULL END,updated_at=now() WHERE id=$1",[id,retry?'retry_needed':actual?'not_due':'done']);
   const next=retry?'retry_needed':actual?'not_due':'done';if(r.cleanup_status!==next)await repo.event(c,r,'cleanup',r.status,retry?'STORAGE_IO':next,'cleanup:'+randomUUID());
  });
 }
 async function fail(id:string,reason:string){const q=queued.get(id);if(q){q.abort.abort(taskError(reason));await q.done;await cleanup(id);return;}const a=active.get(id);if(a){a.abort.abort(taskError(reason));await a.done;}else{const r=await repo.get(id);if(['receiving','validating','queued','processing','sending'].includes(r?.status)&&(!await stopped(r)||!await groupStopped(r.child_pid,r.child_host,hostname())))return;await repo.finish(id,reason,r);}await cleanup(id);}
 async function sweep(recovery=false){
  let blocked=false;
  const rows=(await pool.query("SELECT *,expires_at<=clock_timestamp() AS due,lease_expires_at<=clock_timestamp() AS lease_due FROM tasks WHERE status NOT IN ('succeeded','failed','expired') OR cleanup_status<>'done' ORDER BY created_at,id")).rows;
  for(const r of rows){if(r.child_pid&&!active.has(r.id)&&!queued.has(r.id)&&!await groupStopped(r.child_pid,r.child_host,hostname()))blocked=true;if(!terminal(r.status)){
   if(r.due)await fail(r.id,'TASK_EXPIRED');
   else if((recovery||r.lease_due&&['queued','processing','sending'].includes(r.status))&&!active.has(r.id)&&await stopped(r)&&await groupStopped(r.child_pid,r.child_host,hostname()))await fail(r.id,'WORKER_INTERRUPTED');
  }await cleanup(r.id);}quarantined=blocked;
 }
 async function open(request:Opening){
  if(closing||quarantined)throw taskError('UNAVAILABLE');const identity=await authenticate(request.authorization);const outputFormat=parseOutputFormat(request.outputFormat);
  if(typeof request.docKey!=='string'||!request.docKey.trim()||request.docKey.includes(',')||request.docKey.length>200)throw taskError('INVALID_REQUEST');
  if(request.contentEncoding&&request.contentEncoding!=='identity')throw taskError('UNSUPPORTED_MEDIA');taskBoundary(request.contentType);
  if(!identity.docKeys.includes(request.docKey))throw taskError('TEMPLATE_NOT_FOUND');const selected=await loadTemplate(pool,request.docKey);if(!selected.ok)throw taskError('TEMPLATE_NOT_FOUND');
  if((request.queueMode||resources.enabled())&&!resources.ready())throw taskError('UNAVAILABLE');
  const v=selected.value,r=await repo.create(identity,v.versionId,{docKey:request.docKey,version:v.template.definition.version,fingerprint:v.template.fingerprint},request.queueMode,outputFormat,v.template.definition.defaultFileName??'document');opened.add(r.id);return safeTask(r);
 }
 async function receive(request:Receiving){
  if(closing)throw taskError('UNAVAILABLE');const {r,i}=await owned(request.authorization,request.taskId,true),boundary=taskBoundary(request.contentType);
  const claimed=await repo.claim(r.id,i.principalId),token=claimed.lease_token,limits=claimed.resource_policy as TaskPolicy;opened.delete(r.id);
  // A queued cancellation can arrive during the claim, before pipeline attaches its iterator.
  request.body.on('error',()=>{});
  const abort=new AbortController();let resolveDone!:()=>void;const done=new Promise<void>(res=>{resolveDone=res;});active.set(r.id,{abort,done});
  const rawClosed=new Set<number>(),streams=new Map<Readable,number>();let preserveClosed=false;
  const stop=()=>{const e=abort.signal.reason??taskError('CONNECTION_LOST');request.body.destroy(e);for(const [s,n] of streams)if(!preserveClosed||!rawClosed.has(n))s.destroy(e);};abort.signal.addEventListener('abort',stop,{once:true});
  const external=()=>{preserveClosed=true;abort.abort(externalReason(request.signal));};request.signal?.addEventListener('abort',external,{once:true});
  const inputIdle=usesInputWaitBudget(limits.version)?createReceiveIdle(limits.idleMs,()=>abort.abort(taskError('TASK_TIMEOUT'))):null;
  const local=<T>(operation:()=>Promise<T>):Promise<T>=>inputIdle?inputIdle.work(operation):operation();
  let idle:NodeJS.Timeout;const reset=()=>{if(inputIdle)return;clearTimeout(idle);idle=setTimeout(()=>abort.abort(taskError('TASK_TIMEOUT')),limits.idleMs);};reset();
  const deadline=setTimeout(()=>abort.abort(taskError(+claimed.expires_at<=Date.now()?'TASK_EXPIRED':'TASK_TIMEOUT')),Math.max(1,Math.min(limits.receiveMs,+claimed.expires_at-Date.now())));
  const renew=setInterval(()=>{void repo.renew(r.id,token).then(ok=>{if(!ok)abort.abort(taskError('WORKER_INTERRUPTED'));}).catch(()=>abort.abort(taskError('WORKER_INTERRUPTED')));},Math.min(10000,Math.floor(limits.leaseMs/3)));
  let wire=0,index=0,indexBytes=0,payloadSeen=false,meta={actorRef:null as string|null,reference:null as string|null};let sequence=Promise.resolve();const pending:Promise<void>[]=[],digest=createHash('sha256');
  const parser=new Busboy({headers:{'content-type':request.contentType},isPartAFile:()=>true,highWaterMark:65536,fileHwm:65536,defCharset:'utf8',limits:{parts:limits.maxParts,files:limits.maxParts,fieldNameSize:2048,headerSize:16384,fileSize:limits.requestBytes}});
  parser.on('error',()=>{});for(const name of ['partsLimit','filesLimit','fieldsLimit'])parser.on(name,()=>abort.abort(taskError('LIMIT_EXCEEDED')));
  async function save(name:string,source:Readable,type:string,encoding:string,order:number){
   const check=()=>{if(abort.signal.aborted&&!(preserveClosed&&rawClosed.has(order)))throw abort.signal.reason;};check();
   if(Buffer.byteLength(name)>2048||/[\x00-\x1f\x7f]/.test(name)||!['7bit','8bit','binary'].includes(encoding.toLowerCase()))throw taskError('INVALID_REQUEST');
   const isPayload=name==='payload';if(order===0&&!isPayload||isPayload&&payloadSeen)throw taskError('INVALID_REQUEST');
   if(isPayload){payloadSeen=true;if(type!=='application/json')throw taskError('UNSUPPORTED_MEDIA');}
   else if(!name.startsWith('/')||/~(?![01])/.test(name))throw taskError('INVALID_REQUEST');
   indexBytes+=Buffer.byteLength(name)+256;if(indexBytes>limits.maxIndexBytes)throw taskError('LIMIT_EXCEEDED');
   const id=randomUUID(),key=r.id+'/input/'+id+'.bin.part',max=isPayload?limits.jsonBytes:limits.imageBytes;
   const handle=await local(async()=>{await pool.query("INSERT INTO task_files(id,task_id,role,logical_path,part_order,media_type,storage_key,state) VALUES($1,$2,$3,$4,$5,$6,$7,'receiving')",[id,r.id,isPayload?'payload':'original_image',isPayload?'':name,order,type,key]);
   return files.open(key);}),hash=createHash('sha256');let count=0,omitted=!isPayload&&!['image/jpeg','image/png'].includes(type),stored=0;
   try{for await(const raw of source){const b=Buffer.from(raw as Uint8Array);for(let offset=0;offset<b.length;offset+=65536){check();const chunk=b.subarray(offset,offset+65536);count+=chunk.length;
     if(count>max){if(isPayload)throw taskError('LIMIT_EXCEEDED');omitted=true;}
     if(omitted)continue;
     await local(async()=>{
     const used=Number((await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1',[r.id])).rows[0].storage_used_bytes);
     await repo.reserve(r.id,used+chunk.length,token);await (deps.writeChunk?deps.writeChunk(handle,chunk):handle.writeFile(chunk));stored+=chunk.length;hash.update(chunk);
     await transaction(pool,async c=>{await quotaLock(c);await repo.row(c,r.id);await c.query('UPDATE task_resource_reservations SET storage_used_bytes=storage_used_bytes+$2,updated_at=now() WHERE task_id=$1',[r.id,chunk.length]);await c.query('UPDATE task_files SET stored_bytes=$2,received_bytes=$3,updated_at=now() WHERE id=$1',[id,stored,count]);});
     });
    }}
   }finally{await local(()=>handle.close());}
   await local(async()=>{
   if((source as any).truncated)throw taskError('LIMIT_EXCEEDED');check();
   if(omitted){await files.remove(key);await transaction(pool,async c=>{await quotaLock(c);await c.query('UPDATE task_resource_reservations SET storage_used_bytes=storage_used_bytes-$2 WHERE task_id=$1',[r.id,stored]);await c.query("UPDATE task_files SET state='omitted',error_code=$2,storage_key=NULL,stored_bytes=0,received_bytes=$3,deleted_at=clock_timestamp(),updated_at=now() WHERE id=$1",[id,count>max?'IMAGE_LIMIT':'IMAGE_UNUSABLE',count]);});digest.update(JSON.stringify([order,name,'omitted',count]));return;}
   await repo.reserve(r.id,Number((await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1',[r.id])).rows[0].storage_used_bytes),token);
   const final=await files.publish(key),sha=hash.digest('hex');await pool.query("UPDATE task_files SET state='received',storage_key=$2,checksum=$3,received_bytes=$4,published_at=clock_timestamp(),updated_at=now() WHERE id=$1",[id,final,sha,count]);
   digest.update(JSON.stringify([order,name,sha,count]));
   if(isPayload)meta=await inspectPayload(await files.path(final),limits,preserveClosed&&rawClosed.has(order)?AbortSignal.timeout(5000):abort.signal);
   });
  }
  parser.on('file',(name,source,_filename,encoding,type)=>{const order=index++;streams.set(source,order);source.on('error',()=>{});source.on('limit',()=>abort.abort(taskError('LIMIT_EXCEEDED')));
   const operation=sequence.then(()=>save(name,source,type,encoding,order));sequence=operation;pending.push(operation);void operation.catch(e=>abort.abort(e)).finally(()=>streams.delete(source));
  });
  if(request.signal?.aborted)external();
  try{
   const input=Readable.from((async function*(){const iterator=request.body[Symbol.asyncIterator]();try{while(true){const next=await(inputIdle?inputIdle.wait(()=>iterator.next()):iterator.next());if(next.done)break;const raw=next.value;const b=Buffer.isBuffer(raw)?raw:Buffer.from((raw as Uint8Array).buffer,(raw as Uint8Array).byteOffset,(raw as Uint8Array).byteLength);for(let i=0;i<b.length;i+=65536)yield b.subarray(i,i+65536);}}finally{inputIdle?.stop();await iterator.return?.();}})(),{objectMode:false,highWaterMark:65536});
   await pipeline(input,new Transform({transform(chunk:Buffer,_e,cb){wire+=chunk.length;reset();if(wire>limits.requestBytes)cb(taskError('LIMIT_EXCEEDED'));else cb(null,chunk);}}),headerBudget(boundary,n=>rawClosed.add(n)),parser,{signal:abort.signal});
   await sequence;if(!payloadSeen)throw taskError('INVALID_REQUEST');return safeTask(await repo.seal(r.id,token,digest.digest('hex'),meta,wire));
  }catch(e){if(!abort.signal.aborted)preserveClosed=true;abort.abort((e as any)?.code==='ABORT_ERR'?taskError('CONNECTION_LOST'):e);await Promise.allSettled(pending);
   await pool.query('UPDATE tasks SET request_bytes=$2 WHERE id=$1 AND terminal_at IS NULL',[r.id,wire]);
   const original=abort.signal.reason,code=['ENOSPC','EIO','EACCES','EROFS'].includes(original?.code)?'STORAGE_IO':typeof original?.code==='string'&&/^(TASK_|LIMIT_|INVALID_|UNSUPPORTED_|STORAGE_|WORKER_|CONNECTION_|RESOURCE_|UNAVAILABLE$)/.test(original.code)?original.code:'INVALID_REQUEST';
   await repo.finish(r.id,code);throw taskError((await repo.get(r.id)).terminal_reason);
  }finally{inputIdle?.stop();clearTimeout(idle!);clearTimeout(deadline);clearInterval(renew);request.signal?.removeEventListener('abort',external);abort.signal.removeEventListener('abort',stop);active.delete(r.id);try{await cleanup(r.id);}finally{resolveDone();}}
 }
 async function normalize(request:{authorization:string;taskId:string;signal?:AbortSignal}){
  if(closing)throw taskError('UNAVAILABLE');const {r,i}=await owned(request.authorization,request.taskId,true),claimed=await repo.claimValidation(r.id,i.principalId);if(claimed.normalized_at)return safeTask(claimed);const token=claimed.lease_token,abort=new AbortController();let resolveDone!:()=>void;const done=new Promise<void>(res=>{resolveDone=res;});active.set(r.id,{abort,done});
  const external=()=>abort.abort(externalReason(request.signal));request.signal?.addEventListener('abort',external,{once:true});if(request.signal?.aborted)external();
  const validationEnd=+claimed.validation_started_at+(claimed.resource_policy.validateMs??900000),absoluteEnd=+claimed.expires_at;const deadline=setTimeout(()=>abort.abort(taskError(absoluteEnd<=validationEnd?'TASK_EXPIRED':'TASK_TIMEOUT')),Math.max(1,Math.min(absoluteEnd,validationEnd)-Date.now()));const renew=setInterval(()=>{void repo.renew(r.id,token).then(ok=>{if(!ok)abort.abort(taskError('WORKER_INTERRUPTED'));}).catch(()=>abort.abort(taskError('WORKER_INTERRUPTED')));},Math.min(10000,Math.floor(claimed.resource_policy.leaseMs/3)));
  try{return safeTask(await normalizeStoredTask({pool,files,repo,row:claimed,token,signal:abort.signal,...(deps.writeChunk?{writeChunk:deps.writeChunk}:{})}));}
  catch(e){const raw=(abort.signal.aborted?abort.signal.reason:e) as any,code=['ENOSPC','EIO','EACCES','EROFS'].includes(raw?.code)?'STORAGE_IO':typeof raw?.code==='string'&&/^(TASK_|LIMIT_|INVALID_|TYPE_|MISSING_|UNKNOWN_|SECTION_|STORAGE_|WORKER_|CONNECTION_|RESOURCE_|UNAVAILABLE$)/.test(raw.code)?raw.code:'INVALID_DATA';await repo.finish(r.id,code);throw taskError((await repo.get(r.id)).terminal_reason);}
  finally{request.signal?.removeEventListener('abort',external);clearTimeout(deadline);clearInterval(renew);active.delete(r.id);try{await cleanup(r.id);}finally{resolveDone();}}
 }
 async function receiveQueued(request:Receiving&{legacyPipeline?:boolean;onReceived?:()=>Promise<void>}){
  const {r}=await owned(request.authorization,request.taskId,true);
  if(closing)throw taskError('UNAVAILABLE');
  if(!request.legacyPipeline&&!isQueuePolicyVersion(r.resource_policy.version)||r.status!=='awaiting_input'||queued.has(r.id)||active.has(r.id))throw taskError('TASK_REQUEST_CONFLICT');
  const abort=new AbortController();let done!:()=>void;const state={abort,done:new Promise<void>(r=>{done=r;}),stage:'waiting' as 'waiting'|'receiving'|'validating'};queued.set(r.id,state);
  const external=()=>abort.abort(externalReason(request.signal));request.signal?.addEventListener('abort',external,{once:true});if(request.signal?.aborted)external();
  const deadline=setTimeout(()=>abort.abort(taskError('TASK_EXPIRED')),Math.max(1,+r.expires_at-Date.now()));
  let renewing=false;const renew=setInterval(()=>{if(renewing||state.stage!=='waiting')return;renewing=true;void(async()=>{const current=await repo.get(r.id);if(state.stage!=='waiting')return;if(current.due)abort.abort(taskError('TASK_EXPIRED'));else if(terminal(current.status))abort.abort(taskError(current.terminal_reason??'WORKER_INTERRUPTED'));else if(current.lease_token&&!await repo.renew(r.id,current.lease_token)&&state.stage==='waiting')abort.abort(taskError('WORKER_INTERRUPTED'));})().catch(()=>abort.abort(taskError('WORKER_INTERRUPTED'))).finally(()=>{renewing=false;});},Math.min(10000,Math.floor(r.resource_policy.leaseMs/3)));
  let grant:{release():void}|undefined;
  try{
   grant=await resources.acquire(r.id,{kind:'intake',order:+r.created_at,expiresAt:+r.expires_at,signal:abort.signal,onStop:code=>abort.abort(taskError(code))});
   state.stage='receiving';await receive({...request,signal:abort.signal});abort.signal.throwIfAborted();await request.onReceived?.();
   state.stage='validating';return await normalize({authorization:request.authorization,taskId:r.id,signal:abort.signal});
  }catch(e){const raw=(abort.signal.aborted?abort.signal.reason:e) as any;const code=typeof raw?.code==='string'?raw.code:'UNAVAILABLE';await repo.finish(r.id,code);throw taskError((await repo.get(r.id)).terminal_reason??code);}
  finally{clearTimeout(deadline);clearInterval(renew);request.signal?.removeEventListener('abort',external);queued.delete(r.id);grant?.release();try{await cleanup(r.id);}finally{done();}}
 }
 async function findings(header:string,id:string,cursor=0,limit=50){await owned(header,id);if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw taskError('INVALID_REQUEST');const rows=(await pool.query('SELECT * FROM task_findings WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',[id,cursor,limit+1])).rows;const items=rows.slice(0,limit).map(f=>({id:f.id,sequence:Number(f.sequence),code:f.code,sectionId:f.section_id,pointer:f.pointer,locatorSha256:f.locator_sha256,affectedPlacementCount:Number(f.affected_placement_count),...(Object.keys(f.detail??{}).length?{detail:f.detail}:{})}));return {items,nextCursor:rows.length>limit?items.at(-1)!.sequence:null};}
 await sweep(true);let maintenance:Promise<void>|undefined;
 const timer=setInterval(()=>{if(closing||maintenance)return;maintenance=sweep().catch(()=>{}).finally(()=>{maintenance=undefined;});},p.sweepMs);timer.unref();
 return {authenticate,quarantined:()=>quarantined,processingContext:{pool,files,repo,owned,active,cleanup,policy:p,resources},open,receive,normalize,receiveQueued,findings,reserve:repo.reserve,async inspect(header:string,id:string){return safeTask((await owned(header,id)).r);},fail,
  queueSnapshot:resources.snapshot,
  queueState(id:string){const state=queued.get(id);return state?{stage:state.stage,waitReason:state.stage==='waiting'?(resources.snapshot().intakes>=2?'receive_slot':'memory'):null}:null;},
  sharedQueueEnabled:resources.enabled,
  queueCapability(){const q=queuePolicy(p,profile);return resources.ready()?{mode:'queue-v1',earlyResponse:true,continuedUpload:true,maxOutstanding:q.maxOutstanding,maxOwnerTasks:q.maxOwnerTasks,maxIntakes:2,maxProcessing:profile.maxProcessing,maxSenders:2,...(profile.adaptiveProcessing?{adaptiveProcessing:{enabled:true,minimum:1,maximum:profile.maxProcessing}}:{}),...(profile.strict?{resourceProfile:{name:profile.name,memoryBytes:profile.memoryBytes,cpuCount:profile.cpuCount,admissionBytes:profile.admissionMiB*1048576,pressureBytes:profile.pressureMiB*1048576,resumeBytes:profile.resumeMiB*1048576,emergencyBytes:profile.emergencyMiB*1048576}}:{})}:null;},
  async recover(){await sweep(true);},async sweep(){await sweep();},
  async stop(){closing=true;clearInterval(timer);await resources.stop();for(const q of queued.values())q.abort.abort(taskError('WORKER_INTERRUPTED'));for(const a of active.values())a.abort.abort(taskError('WORKER_INTERRUPTED'));await Promise.all([...queued.values(),...active.values()].map(a=>a.done));await maintenance;for(const id of opened){const r=await repo.get(id);if(r?.status==='awaiting_input')await fail(id,'WORKER_INTERRUPTED');}}
 };
}
