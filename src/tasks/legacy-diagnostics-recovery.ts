import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {OperationError} from '../errors.js';
import {assertRuntimeSchema} from '../db/runtime-schema.js';

const hashes={
 'src/tasks/render.ts':'538523243585683b4e6e17f7cebebcb2720fa23ee8adf37f6e926627097fd6c5',
 'src/tasks/normalize.ts':'8ecea1faf3eadd826b1795ad73f4fe2396dd82683a0d40919b94f1f523b5072d',
 'src/tasks/public.ts':'98bb6e52654ce61e8a61da88eabee1365e38d084c46abdec521cd215abdd033a'
};
const core='ed876f4d011ad943ead937307af9123581c231124cab198de34f60b832f6a532';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,hex=/^[a-f0-9]{64}$/;
const error=(code:string)=>new OperationError(code,'diagnostics','Diagnostics recovery request could not be completed');
const object=(x:any)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x:any,allowed:string[])=>object(x)&&Object.keys(x).length===allowed.length&&Object.keys(x).every(k=>allowed.includes(k));
const integer=(n:any)=>Number.isSafeInteger(n)&&n>=0&&n<=10000;
function digest(x:any):string{return createHash('sha256').update(JSON.stringify(x,(_key,v)=>{
 if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))throw error('RECOVERY_INPUT_INVALID');
 return object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v;
})).digest('hex');}
function evidence(id:string,e:any){
 if(!uuid.test(id)||!keys(e,['version','kind','taskId','writer','sourceHashes','sourceEvidenceSha256','operator','basis'])||e.version!==1||e.kind!=='legacy-diagnostics-writer-attestation'||e.taskId!==id||typeof e.operator!=='string'||!/^[a-zA-Z0-9_.:@-]{1,100}$/.test(e.operator)||typeof e.basis!=='string'||!e.basis.trim()||e.basis.length>500||!hex.test(e.sourceEvidenceSha256))throw error('RECOVERY_INPUT_INVALID');
 // This checks an operator's pinned-writer attestation, not a runtime signature.
 if(e.writer!=='flowdoc-service/f82d7c6'||!keys(e.sourceHashes,Object.keys(hashes))||Object.entries(hashes).some(([k,v])=>e.sourceHashes[k]!==v))throw error('RECOVERY_WRITER_UNVERIFIED');
 return digest(e);
}
export async function readRecoveryArtifact(path:string):Promise<any>{try{const s=await lstat(path);if(!s.isFile()||s.size>65536)throw Error();const b=await readFile(path);if(b.length>65536)throw Error();return JSON.parse(b.toString('utf8'));}catch{throw error('RECOVERY_INPUT_INVALID');}}
async function target(c:PoolClient){const r=(await c.query("SELECT s.system_identifier::text AS cluster,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database,current_schema() AS schema FROM pg_control_system() s")).rows[0];if(!r?.cluster||!r.database||!r.schema)throw error('RECOVERY_UNAVAILABLE');return digest(r);}
async function snapshot(c:PoolClient,id:string){
 const row=(await c.query('SELECT to_jsonb(t) AS row FROM tasks t WHERE id=$1',[id])).rows[0]?.row;if(!row)throw error('TASK_NOT_FOUND');
 const size=(await c.query("SELECT (SELECT coalesce(sum(octet_length(to_jsonb(f)::text)),0) FROM task_findings f WHERE task_id=$1)+(SELECT coalesce(sum(octet_length(to_jsonb(e)::text)),0) FROM task_events e WHERE task_id=$1) AS bytes",[id])).rows[0].bytes;
 if(Number(size)>8*1048576)return {row,limited:true};
 const findings=(await c.query('SELECT to_jsonb(f) AS value FROM task_findings f WHERE task_id=$1 ORDER BY sequence',[id])).rows.map(r=>r.value);
 const events=(await c.query('SELECT to_jsonb(e) AS value FROM task_events e WHERE task_id=$1 ORDER BY sequence',[id])).rows.map(r=>r.value);
 const reservation=(await c.query('SELECT to_jsonb(r) AS value FROM task_resource_reservations r WHERE task_id=$1',[id])).rows[0]?.value;
 return {row,findings,events,reservation,limited:false};
}
function classify(s:any):any{
 if(s.limited)return {decision:'UNVERIFIED_EVIDENCE_LIMIT'};
 const r=s.row,n=r.normalization_summary,cap=r.resource_policy.findingDetails;
 if(s.events.some((e:any)=>e.event_type==='preparation-finding'))return {decision:'ALREADY_LEDGER'};
 if(r.generation_summary)return {decision:'ALREADY_SUMMARIZED'};
 if(!['failed','expired'].includes(r.status)||!r.terminal_at||r.child_pid||r.writer_pid||r.lease_token||!s.reservation||s.reservation.queue_slot_held||s.reservation.storage_held_bytes!==s.reservation.storage_used_bytes)return {decision:'BLOCKED_LIFECYCLE'};
 if(!n||n.coreVersion!=='0.5.2'||n.coreSha256!==core||r.normalization_version!==2||!Number.isSafeInteger(cap)||cap<1||cap>10000||n.detailsTruncated!==false||!integer(n.findingCount)||!integer(n.omittedPlacementCount))return {decision:'UNVERIFIED_NORMALIZATION'};
 if(s.findings.length>=cap)return {decision:'UNVERIFIED_AT_CAP'};
 let count=0,omitted=0,normal=0,normalOmitted=0,seenPreparation=false;
 for(const [i,f]of s.findings.entries()){
  if(f.sequence!==i+1||!integer(f.affected_placement_count))return {decision:'BLOCKED_FINDING_INTEGRITY'};
  if(f.detail?.stage==='preparation'){
   seenPreparation=true;
   if(f.code!=='IMAGE_UNUSABLE'||typeof f.section_id!=='string'||!f.section_id.startsWith('instance-')||f.affected_placement_count<1||typeof f.pointer!=='string'||!f.pointer.startsWith('/sections/')||!Array.isArray(f.detail.nodeIdsSample)||!f.detail.nodeIdsSample.length||f.detail.nodeIdsSample.some((x:any)=>typeof x!=='string'||!x.includes(f.section_id)))return {decision:'BLOCKED_FINDING_INTEGRITY'};
   count++;omitted+=f.affected_placement_count;
  }else{if(seenPreparation||Object.keys(f.detail??{}).length)return {decision:'BLOCKED_FINDING_INTEGRITY'};normal++;normalOmitted+=f.affected_placement_count;}
 }
 if(normal!==n.findingCount||normalOmitted!==n.omittedPlacementCount)return {decision:'UNVERIFIED_NORMALIZATION'};
 if(!integer(count)||!integer(omitted))return {decision:'BLOCKED_FINDING_INTEGRITY'};
 return {decision:count?'RECOVERABLE_EXACT':'EXACT_ZERO',preparation:{findingCount:count,omittedPlacementCount:omitted}};
}
async function run<T>(pool:Pick<Pool,'connect'>,readonly:boolean,work:(c:PoolClient)=>Promise<T>):Promise<T>{
 let c:PoolClient|undefined,discard=false;
 try{c=await pool.connect();await c.query(readonly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL TIME ZONE 'UTC'");await assertRuntimeSchema(c);const v=await work(c);await c.query('COMMIT');return v;}
 catch(e){if(c)try{await c.query('ROLLBACK');}catch{discard=true;}throw e instanceof OperationError?e:error('RECOVERY_UNAVAILABLE');}
 finally{c?.release(discard);}
}
export async function planLegacyDiagnostics(pool:Pick<Pool,'connect'>,id:string,writerEvidence:unknown){
 const writerEvidenceDigest=evidence(id,writerEvidence);
 return run(pool,true,async c=>{const databaseFingerprint=await target(c),s=await snapshot(c,id),decision=classify(s);
  if(decision.decision!=='RECOVERABLE_EXACT')return decision;
  const body={contract:'flowdoc-legacy-diagnostics-plan/1',taskId:id,databaseFingerprint,writerEvidenceDigest,snapshotDigest:digest(s),preparation:decision.preparation};
  return {...decision,writerAssurance:'operator-attested-pinned-writer',plan:{...body,proofDigest:digest(body)}};
 });
}
export async function applyLegacyDiagnostics(pool:Pick<Pool,'connect'>,plan:any,writerEvidence:unknown){
 if(!keys(plan,['contract','taskId','databaseFingerprint','writerEvidenceDigest','snapshotDigest','preparation','proofDigest'])||plan.contract!=='flowdoc-legacy-diagnostics-plan/1'||typeof plan.taskId!=='string'||!uuid.test(plan.taskId)||!['databaseFingerprint','writerEvidenceDigest','snapshotDigest','proofDigest'].every(k=>typeof plan[k]==='string'&&hex.test(plan[k]))||!keys(plan.preparation,['findingCount','omittedPlacementCount'])||!integer(plan.preparation.findingCount)||!plan.preparation.findingCount||!integer(plan.preparation.omittedPlacementCount)||plan.preparation.omittedPlacementCount<plan.preparation.findingCount)throw error('RECOVERY_PLAN_INVALID');
 const {proofDigest,...body}=plan;if(digest(body)!==proofDigest)throw error('RECOVERY_PLAN_INVALID');
 if(evidence(plan.taskId,writerEvidence)!==plan.writerEvidenceDigest)throw error('RECOVERY_PLAN_MISMATCH');
 return run(pool,false,async c=>{
  if(await target(c)!==plan.databaseFingerprint)throw error('RECOVERY_TARGET_MISMATCH');
  await c.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[plan.taskId]);
  const s=await snapshot(c,plan.taskId),key='preparation-finding:legacy-recovery:'+plan.taskId,existing=s.events?.find((e:any)=>e.event_key===key);
  const detail={version:1,...plan.preparation,recovery:{kind:'legacy-reconstruction/1',proofDigest:plan.proofDigest,writerEvidenceDigest:plan.writerEvidenceDigest,databaseFingerprint:plan.databaseFingerprint}};
  if(existing){if(existing.event_type!=='preparation-finding'||digest(existing.detail)!==digest(detail))throw error('RECOVERY_CONFLICT');return {status:'already-applied',taskId:plan.taskId};}
  if(s.limited||digest(s)!==plan.snapshotDigest)throw error('RECOVERY_STALE_PLAN');
  const current=classify(s);if(current.decision!=='RECOVERABLE_EXACT'||digest(current.preparation)!==digest(plan.preparation))throw error('RECOVERY_PLAN_MISMATCH');
  const actor='legacy-diagnostics-cli:'+ (writerEvidence as any).operator;
  await c.query("INSERT INTO task_events(task_id,sequence,event_key,event_type,previous_state,new_state,actor,reason,detail) SELECT $1,coalesce(max(sequence),0)+1,$2,'preparation-finding',$3,$3,$4,'Exact retained legacy finding reconstruction; no execution',$5 FROM task_events WHERE task_id=$1",[plan.taskId,key,s.row.status,actor,JSON.stringify(detail)]);
  return {status:'applied',taskId:plan.taskId};
 });
}
