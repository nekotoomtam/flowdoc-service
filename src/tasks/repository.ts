import {deliveryEvidence} from './delivery.js';
import type {OutputFormat} from './output-format.js';
import type {Pool,PoolClient} from 'pg';import {randomUUID} from 'node:crypto';import {hostname} from 'node:os';
import {groupStopped,processIdentity} from './workspace.js';
import {queuePolicy} from './policy.js';
import {DEFAULT_QUEUE_PROFILE,type QueueProfile} from './queue-profile.js';
import {selectOutputName} from './output-name.js';
import {transaction} from '../db/connection.js';import {quotaLock,storageTotals,taskError} from './quota.js';import type {TaskPolicy} from './policy.js';
export const terminal=(s:string)=>['failed','expired','succeeded'].includes(s);
export interface TaskIdentity{ownerKey:string;principalId:string;billingSubjectKey?:string;docKeys:readonly string[];taskRead:boolean}
export const taskCompleteness=(r:any,summary=r.generation_summary)=>r.normalization_summary?.completeness==='partial'||summary?.completeness==='partial'?'partial':r.normalization_summary?.completeness==='complete'&&summary?.completeness==='complete'?'complete':'unknown';
export const safeTask=(r:any)=>({taskId:r.id,outputFormat:r.output_format,...(r.file_name?{fileName:r.file_name}:{}),status:r.status,createdAt:r.created_at.toISOString(),expiresAt:r.expires_at.toISOString(),
 creator:{principalId:r.created_by_principal,actorRef:r.client_actor_ref},billingSubjectKey:r.billing_subject_key,
 template:r.template_pin,inputDigest:r.input_digest,...(r.normalized_at?{normalization:{completedAt:r.normalized_at.toISOString(),digest:r.normalized_digest,summary:r.normalization_summary}}:{}),...(r.generation_summary?{generationSummary:r.generation_summary,completeness:taskCompleteness(r)}:{}),cleanup:{status:r.cleanup_status},error:r.terminal_reason});
export function taskRepository(pool:Pool,policy:TaskPolicy,freeBytes:()=>Promise<number>,profile:QueueProfile=DEFAULT_QUEUE_PROFILE,runtime?:{runtimeId:string;storageId:string;canRecover:(row:any)=>Promise<boolean>}){
 let identityColumn:boolean|undefined;
 async function hasIdentityColumn(c:PoolClient){return identityColumn??=(await c.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='writer_start_identity') AS present")).rows[0].present as boolean;}
 async function row(c:PoolClient,id:string){const r=(await c.query("SELECT *,expires_at<=clock_timestamp() AS due,lease_expires_at<=clock_timestamp() AS lease_due,(status='validating' AND (to_jsonb(tasks)->>'normalized_at') IS NULL AND (to_jsonb(tasks)->>'validation_started_at') IS NOT NULL AND clock_timestamp()>=(to_jsonb(tasks)->>'validation_started_at')::timestamptz+(coalesce((resource_policy->>'validateMs')::bigint,900000)*interval '1 millisecond')) AS validation_due FROM tasks WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!r)throw taskError('TASK_NOT_FOUND');return r;}
 async function event(c:PoolClient,r:any,type:string,from:string|null,reason:string|null=null,key=type){await c.query(`INSERT INTO task_events(task_id,sequence,event_key,event_type,previous_state,new_state,actor,reason) SELECT $1,coalesce(max(sequence),0)+1,$2,$3,$4,$5,$6,$7 FROM task_events WHERE task_id=$1`,[r.id,key,type,from,r.status,r.created_by_principal,reason]);}
 async function capacity(c:PoolClient,delta:number,p:TaskPolicy){const t=await storageTotals(c),free=await freeBytes();
  if(!Number.isSafeInteger(free)||free<0||t.held+t.legacy+delta>Math.min(p.poolBytes,t.pool??p.poolBytes)||t.held-t.used+t.legacyUnused+delta>free-Math.max(p.freeFloorBytes,t.floor))throw taskError('STORAGE_CAPACITY','Temporary storage capacity unavailable');
 }
 const live=(r:any)=>{if(r.due)throw taskError('TASK_EXPIRED');if(r.validation_due)throw taskError('TASK_TIMEOUT');if(terminal(r.status))throw taskError('TASK_REQUEST_CONFLICT');};
 async function reserveLocked(c:PoolClient,r:any,needed:number){
  if(!Number.isSafeInteger(needed)||needed<0)throw taskError('LIMIT_EXCEEDED');
  const p=r.resource_policy as TaskPolicy,q=(await c.query('SELECT * FROM task_resource_reservations WHERE task_id=$1 FOR UPDATE',[r.id])).rows[0];
  if(needed>p.taskBytes)throw taskError('LIMIT_EXCEEDED');const held=Number(q.storage_held_bytes),target=Math.min(p.taskBytes,held+Math.ceil(Math.max(0,needed-held)/p.growthBytes)*p.growthBytes);
  await capacity(c,target-held,p);if(target>held)await c.query('UPDATE task_resource_reservations SET storage_held_bytes=$2,updated_at=now() WHERE task_id=$1',[r.id,target]);return target;
 }
 async function finishLocked(c:PoolClient,r:any,reason:string,facts:Record<string,unknown>={}){const id=r.id;
   const observed=(await c.query('SELECT j.status,o.byte_size,o.page_count,o.sha256,o.output_format,o.media_type FROM generation_jobs j LEFT JOIN document_outputs o ON o.job_id=j.id WHERE j.task_id=$1',[id])).rows[0];
   const status=r.due?'expired':'failed',code=r.due?'TASK_EXPIRED':reason;
   const n=(await c.query("UPDATE tasks SET status=$2,terminal_at=clock_timestamp(),terminal_reason=$3,lease_token=NULL,lease_expires_at=NULL,writer_pid=NULL,writer_host=NULL,cleanup_status='pending',state_version=state_version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,status,code])).rows[0];
   await c.query("UPDATE generation_jobs SET status='failed',finished_at=clock_timestamp(),errors_json=$2 WHERE task_id=$1 AND status IN ('queued','running')",[id,JSON.stringify([{code,path:'task',message:'Task stopped'}])]);
   await c.query('UPDATE task_resource_reservations SET queue_slot_held=false,updated_at=now() WHERE task_id=$1',[id]);await event(c,n,'terminal',r.status,code);
   await c.query(`INSERT INTO task_usage(task_id,revision,facts) VALUES($1,1,$2)`,[id,JSON.stringify({ownerKey:r.owner_key,principalId:r.created_by_principal,clientActorRef:r.client_actor_ref,billingSubjectKey:r.billing_subject_key,requestKind:r.request_kind,createdAt:r.created_at,expiresAt:r.expires_at,template:r.template_pin,policyVersion:r.resource_policy.version,requestBytes:r.request_bytes===null?null:Number(r.request_bytes),requestBytesMeasurement:r.request_bytes===null?'unknown_after_interruption':'observed',generation:observed?.status==='succeeded'?'succeeded':r.processing_started_at?'interrupted':'not_started',delivery:r.send_started_at?'unknown':'not_started',deliveryEvidence:deliveryEvidence(r.send_started_at?'unknown':'not_started'),outputFormat:r.output_format,output:observed?.byte_size==null?null:{outputFormat:observed.output_format,mediaType:observed.media_type,bytes:Number(observed.byte_size),sha256:observed.sha256,pageCount:observed.page_count},pdfBytes:r.output_format==='pdf'&&observed?.byte_size!=null?Number(observed.byte_size):null,pageCount:observed?.page_count??null,pdfSha256:r.output_format==='pdf'?observed?.sha256??null:null,generationSummary:r.generation_summary??null,completeness:taskCompleteness(r),...facts,status,reason:code,terminalAt:n.terminal_at})]);return n;
 }
 return {row,event,live,reserveLocked,
  // Read-only readiness snapshot. Admission still checks capacity under its
  // quota lock; this probe never reserves bytes or holds that lock.
  async storageReady(){let c:PoolClient|undefined;try{c=await pool.connect();await capacity(c,policy.initialBytes,policy);return true;}catch{return false;}finally{c?.release();}},
  async recoverInterrupted(id:string,expected:{state_version:string;lease_token:string|null}){return transaction(pool,async c=>{await quotaLock(c);const r=await row(c,id);if(r.state_version!==expected.state_version||r.lease_token!==expected.lease_token||!runtime||!await runtime.canRecover(r))return r;
   await c.query("UPDATE tasks SET writer_pid=NULL,writer_host=NULL,writer_start_identity=NULL,child_pid=NULL,child_host=NULL WHERE id=$1",[id]);
   return terminal(r.status)?await row(c,id):finishLocked(c,r,'WORKER_INTERRUPTED');
  });},
  async create(identity:TaskIdentity,versionId:string,pin:unknown,queueMode=false,outputFormat:OutputFormat='pdf',defaultFileName='document'){return transaction(pool,async c=>{
   const p=queueMode?queuePolicy(policy,profile):policy;
   await quotaLock(c);
   const counts=(await c.query(`SELECT count(*) AS tasks,count(*) FILTER(WHERE t.owner_key=$1) AS owned,count(*) FILTER(WHERE t.status IN ('awaiting_input','receiving')) AS receivers FROM tasks t JOIN task_resource_reservations r ON r.task_id=t.id WHERE r.queue_slot_held`,[identity.ownerKey])).rows[0];
   const jobs=Number((await c.query("SELECT count(*) FROM generation_jobs WHERE status IN ('queued','running') AND task_id IS NULL")).rows[0].count);
   if(Number(counts.tasks)>=p.maxTasks||Number(counts.owned)>=p.maxOwnerTasks||!queueMode&&Number(counts.receivers)>=p.maxReceivers||jobs+Number(counts.tasks)>=p.maxOutstanding)throw taskError('QUEUE_FULL');
   await capacity(c,p.initialBytes,p);
   const identityAware=await hasIdentityColumn(c);
   if(runtime&&!(await c.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='runtime_owner_id') AS present")).rows[0].present)throw taskError('TASK_OWNER_UNAVAILABLE');
   const r=(await c.query(`INSERT INTO tasks(owner_key,created_by_principal,billing_subject_key,template_version_id,template_pin,resource_policy,lease_token,lease_expires_at,writer_pid,writer_host,output_format,default_file_name${identityAware?',writer_start_identity':''}${runtime?',runtime_owner_id,storage_identity':''}) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+($8*interval '1 millisecond'),$9,$10,$11,$12${identityAware?',$13':''}${runtime?`,$${identityAware?14:13},$${identityAware?15:14}`:''}) RETURNING *`,[identity.ownerKey,identity.principalId,identity.billingSubjectKey??null,versionId,JSON.stringify(pin),JSON.stringify(p),randomUUID(),p.leaseMs,process.pid,hostname(),outputFormat,defaultFileName,...(identityAware?[await processIdentity(process.pid)]:[]),...(runtime?[runtime.runtimeId,runtime.storageId]:[])])).rows[0];
   await c.query('INSERT INTO task_resource_reservations(task_id,storage_held_bytes,policy_version) VALUES($1,$2,$3)',[r.id,p.initialBytes,p.version]);await event(c,r,'created',null);return r;
  });},
  async get(id:string){return (await pool.query('SELECT *,expires_at<=clock_timestamp() AS due FROM tasks WHERE id=$1',[id])).rows[0];},
  async reserve(id:string,needed:number,token?:string){if(!Number.isSafeInteger(needed)||needed<0)throw taskError('LIMIT_EXCEEDED');return transaction(pool,async c=>{
   await quotaLock(c);const r=await row(c,id);live(r);if(token&&(r.lease_token!==token||r.lease_due))throw taskError('WORKER_INTERRUPTED');
   return reserveLocked(c,r,needed);
  });},
  async claim(id:string,principal:string){return transaction(pool,async c=>{await quotaLock(c);const r=await row(c,id);live(r);if(r.created_by_principal!==principal)throw taskError('FORBIDDEN');if(r.status!=='awaiting_input'||r.receive_started_at)throw taskError('TASK_REQUEST_CONFLICT');
   if(r.lease_due)throw taskError('WORKER_INTERRUPTED');const next=(await c.query(`UPDATE tasks SET status='receiving',receive_started_at=clock_timestamp(),state_version=state_version+1,updated_at=now(),writer_pid=$2,writer_host=$3${Object.hasOwn(r,'writer_start_identity')?',writer_start_identity=$6':''},lease_token=$4,lease_expires_at=LEAST(expires_at,clock_timestamp()+($5*interval '1 millisecond')) WHERE id=$1 RETURNING *`,[id,process.pid,hostname(),randomUUID(),r.resource_policy.leaseMs,...(Object.hasOwn(r,'writer_start_identity')?[await processIdentity(process.pid)]:[])])).rows[0];await event(c,next,'receiving',r.status);return next;});},
  async claimValidation(id:string,principal:string){return transaction(pool,async c=>{await quotaLock(c);const r=await row(c,id);live(r);if(r.created_by_principal!==principal)throw taskError('FORBIDDEN');if(r.status!=='validating'||!r.sealed_at)throw taskError('TASK_REQUEST_CONFLICT');if(r.normalized_at)return r;if(r.lease_token)throw taskError('TASK_REQUEST_CONFLICT');
   const next=(await c.query(`UPDATE tasks SET validation_started_at=clock_timestamp(),state_version=state_version+1,updated_at=now(),writer_pid=$2,writer_host=$3${Object.hasOwn(r,'writer_start_identity')?',writer_start_identity=$6':''},lease_token=$4,lease_expires_at=LEAST(expires_at,clock_timestamp()+($5*interval '1 millisecond')) WHERE id=$1 RETURNING *`,[id,process.pid,hostname(),randomUUID(),r.resource_policy.leaseMs,...(Object.hasOwn(r,'writer_start_identity')?[await processIdentity(process.pid)]:[])])).rows[0];await event(c,next,'normalizing',r.status);return next;});},
  async renew(id:string,token:string){return (await pool.query("UPDATE tasks SET lease_expires_at=LEAST(expires_at,clock_timestamp()+((resource_policy->>'leaseMs')::int*interval '1 millisecond')) WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp() AND status IN ('awaiting_input','receiving','validating','queued','processing','sending') RETURNING id",[id,token])).rowCount===1;},
  async seal(id:string,token:string,digest:string,meta:{actorRef:string|null;reference:string|null;fileName?:string|null},wire:number){return transaction(pool,async c=>{await quotaLock(c);const r=await row(c,id);live(r);if(r.status!=='receiving'||r.lease_token!==token||r.lease_due)throw taskError('WORKER_INTERRUPTED');
   const fileName=selectOutputName(meta.fileName,r.default_file_name);
   const n=(await c.query("UPDATE tasks SET status='validating',sealed_at=clock_timestamp(),input_digest=$3,client_actor_ref=$4,external_reference=$5,request_bytes=$6,file_name=$7,lease_token=NULL,lease_expires_at=NULL,writer_pid=NULL,writer_host=NULL,state_version=state_version+1,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING *",[id,token,digest,meta.actorRef,meta.reference,wire,fileName])).rows[0];await event(c,n,'sealed',r.status);return n;});},
  async finish(id:string,reason:string,expected?:{state_version:string;lease_token:string|null},facts:Record<string,unknown>={}){return transaction(pool,async c=>{await quotaLock(c);const r=await row(c,id);if(terminal(r.status))return r;
   if(expected&&(r.state_version!==expected.state_version||r.lease_token!==expected.lease_token))return r;
   if(!await groupStopped(r.child_pid,r.child_host,hostname()))return r;
   return finishLocked(c,r,reason,facts);
  });}
 };
}
