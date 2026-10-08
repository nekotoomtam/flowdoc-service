import type {Pool,PoolClient} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {transaction} from '../db/connection.js';
import {OperationError} from '../errors.js';
import {validJobId} from '../jobs/repository.js';
import type {ResourceFiles} from '../storage/resource-files.js';
import type {UploadConfig} from './config.js';
import {validateManifest} from './validation.js';
const error=(code:string,message:string)=>new OperationError(code,'upload',message);
export function createUploads(deps:{pool:Pool;files:ResourceFiles;config:UploadConfig;clock?:()=>number}){
 const {pool,files,config}=deps,now=deps.clock??Date.now;
 const active=new Map<string,AbortController>();let closing=false;
 const completions=new Map<string,Promise<void>>();
 const lock=async(c:PoolClient)=>{await c.query('SELECT pg_advisory_xact_lock(60430405)');};
 const session=async(c:PoolClient,id:string)=>{
  if(!validJobId(id))throw error('INVALID_UPLOAD','Invalid upload ID');
  const r=await c.query('SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE',[id]);
  if(!r.rowCount)throw error('UPLOAD_NOT_FOUND','Upload not found');return r.rows[0];
 };
 const usable=(s:any)=>{if(s.status==='expired'||+new Date(s.expires_at)<=now())throw error('UPLOAD_GONE','Upload expired');};
 async function get(id:string){
  if(!validJobId(id))throw error('INVALID_UPLOAD','Invalid upload ID');
  const r=await pool.query('SELECT * FROM upload_sessions WHERE id=$1',[id]);if(!r.rowCount)throw error('UPLOAD_NOT_FOUND','Upload not found');
  const s=r.rows[0],items=(await pool.query('SELECT id,key,source_kind,status,expected_bytes,received_bytes,error_code FROM upload_items WHERE upload_id=$1 ORDER BY created_at,id',[id])).rows;
  return {uploadId:id,status:s.status==='expired'||+new Date(s.expires_at)<=now()?'expired':s.status,expiresAt:s.expires_at,
   items:items.map(i=>({resourceId:i.id,key:i.key,source:i.source_kind,status:i.status,expectedBytes:i.expected_bytes===null?null:Number(i.expected_bytes),receivedBytes:Number(i.received_bytes),errorCode:i.error_code})),
   received:items.filter(i=>i.status==='received').length,declared:items.filter(i=>i.status==='declared').length,total:items.length};
 }
 async function create(input:unknown){
  const m=validateManifest(input,config),digest=createHash('sha256').update(JSON.stringify(m)).digest('hex');
  const id=await transaction(pool,async c=>{
   await lock(c);const old=(await c.query('SELECT * FROM upload_sessions WHERE request_key=$1',[m.requestKey])).rows[0];
   if(old){usable(old);if(old.manifest_digest!==digest)throw error('UPLOAD_CONFLICT','Request key already used');return old.id;}
   const quota=(await c.query('SELECT count(*) AS count,coalesce(sum(reserved_bytes),0) AS bytes FROM upload_sessions WHERE deleted_at IS NULL')).rows[0];
   const size=m.items.reduce((n,i)=>n+(i.source==='upload'?i.byteSize:0),0);
   if(Number(quota.count)>=config.maxSessions||Number(quota.bytes)+size>config.stagingBytes)throw error('UPLOAD_CAPACITY','Staging capacity reached');
   const t=now(),id=(await c.query('INSERT INTO upload_sessions(request_key,manifest_digest,reserved_bytes,last_progress_at,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[m.requestKey,digest,size,new Date(t),new Date(t+Math.min(config.idleMs,config.absoluteMs)),new Date(t+config.absoluteMs)])).rows[0].id;
   for(const i of m.items)await c.query('INSERT INTO upload_items(upload_id,key,source_kind,media_type,expected_bytes,source_url,status) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,i.key,i.source,i.source==='upload'?i.mediaType:null,i.source==='upload'?i.byteSize:null,i.source==='url'?i.url:null,i.source==='url'?'declared':'pending']);
   return id;
  });return {...await get(id),limits:{fileBytes:config.fileBytes,setBytes:config.setBytes,base64Bytes:config.base64Bytes}};
 }
 async function receive(id:string,itemId:string,input:AsyncIterable<Uint8Array>,external?:AbortSignal){
  if(closing)throw error('UNAVAILABLE','Uploads unavailable');
  if(active.size>=config.streams)throw error('UPLOAD_BUSY','Upload streams busy');
  if(!validJobId(itemId))throw error('INVALID_UPLOAD','Invalid resource ID');
  const attempt=randomUUID(),abort=new AbortController();active.set(attempt,abort);
  let complete!:()=>void;completions.set(attempt,new Promise(resolve=>{complete=resolve;}));
  const onAbort=()=>abort.abort();external?.addEventListener('abort',onAbort,{once:true});if(external?.aborted)abort.abort();
  const name=attempt+'.bin';let published=false,claimed=false,old:any,pending:Promise<unknown>|undefined;
  let idle:NodeJS.Timeout|undefined;const reset=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>abort.abort(),config.requestIdleMs);};
  const deadline=setTimeout(()=>abort.abort(),config.requestMs);reset();
  try{
   old=await transaction(pool,async c=>{
    const s=await session(c,id);usable(s);if(s.status!=='open')throw error('UPLOAD_CONFLICT','Upload is immutable');
    const i=(await c.query('SELECT * FROM upload_items WHERE id=$1 AND upload_id=$2 FOR UPDATE',[itemId,id])).rows[0];
    if(!i)throw error('UPLOAD_NOT_FOUND','Resource not found');if(i.source_kind!=='upload'||i.attempt_id)throw error('UPLOAD_CONFLICT','Resource cannot receive');
    await c.query("UPDATE upload_items SET attempt_id=$2,status=CASE WHEN status='received' THEN status ELSE 'receiving' END,error_code=NULL WHERE id=$1",[itemId,attempt]);return i;
   });claimed=true;
   if(old.status==='received'){
    const hash=await files.digest(input,Number(old.expected_bytes),abort.signal,reset);
    if(hash!==old.checksum)throw error('UPLOAD_CONFLICT','Resource differs from completed upload');
    return await get(id);
   }
   let last=0;
   const result=await files.receive(name,input,Number(old.expected_bytes),abort.signal,bytes=>{
    reset();if(now()-last>=1000&&!pending){last=now();pending=pool.query("UPDATE upload_items SET received_bytes=$3,updated_at=$4 WHERE id=$1 AND attempt_id=$2",[itemId,attempt,bytes,new Date(now())]).then(()=>pool.query("UPDATE upload_sessions SET last_progress_at=$2,expires_at=LEAST(absolute_expires_at,$3),updated_at=$2 WHERE id=$1 AND status='open' AND expires_at>$2 RETURNING id",[id,new Date(now()),new Date(now()+config.idleMs)])).then(r=>{if(r.rowCount!==1)abort.abort();}).catch(()=>abort.abort()).finally(()=>{pending=undefined;});}
   });await pending;
   await transaction(pool,async c=>{
    const s=await session(c,id);usable(s);
    const update=await c.query("UPDATE upload_items SET status='received',storage_key=$3,checksum=$4,received_bytes=$5,attempt_id=NULL,updated_at=$6 WHERE id=$1 AND attempt_id=$2",[itemId,attempt,name,result.sha256,result.byteSize,new Date(now())]);
    if(update.rowCount!==1)throw error('UPLOAD_CONFLICT','Attempt no longer active');
    await c.query('UPDATE upload_sessions SET last_progress_at=$2,expires_at=LEAST(absolute_expires_at,$3) WHERE id=$1',[id,new Date(now()),new Date(now()+config.idleMs)]);
   });published=true;return await get(id);
  }finally{
   await pending;
   clearTimeout(deadline);if(idle)clearTimeout(idle);external?.removeEventListener('abort',onAbort);
   try{
    if(claimed&&!published){
     const row=(await pool.query('SELECT storage_key FROM upload_items WHERE id=$1',[itemId])).rows[0];
     if(row?.storage_key!==name)await files.remove(name);
     await files.remove(name+'.part');
     await pool.query("UPDATE upload_items SET attempt_id=NULL,status=CASE WHEN storage_key IS NOT NULL THEN 'received' ELSE 'incomplete' END,received_bytes=CASE WHEN storage_key IS NOT NULL THEN received_bytes ELSE 0 END,error_code=CASE WHEN storage_key IS NOT NULL THEN NULL ELSE 'UPLOAD_INTERRUPTED' END WHERE id=$1 AND attempt_id=$2",[itemId,attempt]);
    }
   }finally{active.delete(attempt);completions.delete(attempt);complete();}
  }
 }
 async function finalize(id:string){
  await transaction(pool,async c=>{
   const s=await session(c,id);usable(s);if(s.status==='ready')return;
   const items=(await c.query('SELECT * FROM upload_items WHERE upload_id=$1',[id])).rows;
   if(items.some(i=>i.attempt_id||!['received','declared'].includes(i.status)))throw error('UPLOAD_INCOMPLETE','Upload set incomplete');
   for(const i of items)if(i.source_kind==='upload'&&!await files.exists(i.storage_key,Number(i.expected_bytes)))throw error('UPLOAD_INCOMPLETE','Resource unavailable');
   await c.query("UPDATE upload_sessions SET status='ready',ready_at=$2,expires_at=$3,updated_at=$2 WHERE id=$1",[id,new Date(now()),new Date(now()+config.readyMs)]);
  });return get(id);
 }
 async function cleanup(){
  const expired=await transaction(pool,async c=>{
   const rows=(await c.query('SELECT id FROM upload_sessions WHERE expires_at<=$1 AND deleted_at IS NULL FOR UPDATE',[new Date(now())])).rows;
   const ids=[];for(const s of rows){const busy=(await c.query('SELECT attempt_id FROM upload_items WHERE upload_id=$1 AND attempt_id IS NOT NULL',[s.id])).rows.some(i=>active.has(i.attempt_id));if(busy)continue;await c.query("UPDATE upload_sessions SET status='expired',retired_at=coalesce(retired_at,$2) WHERE id=$1",[s.id,new Date(now())]);ids.push(s.id);}return ids;
  });
  for(const id of expired){const items=(await pool.query('SELECT storage_key,attempt_id FROM upload_items WHERE upload_id=$1',[id])).rows;for(const i of items){if(i.storage_key)await files.remove(i.storage_key);if(i.attempt_id){await files.remove(i.attempt_id+'.bin');await files.remove(i.attempt_id+'.bin.part');}}
   await transaction(pool,async c=>{await c.query("UPDATE upload_items SET storage_key=NULL,source_url=NULL,attempt_id=NULL,status='expired' WHERE upload_id=$1",[id]);await c.query('UPDATE upload_sessions SET deleted_at=$2,reserved_bytes=0 WHERE id=$1',[id,new Date(now())]);});
  }
  await pool.query('DELETE FROM upload_sessions WHERE deleted_at IS NOT NULL AND deleted_at<=$1',[new Date(now()-config.metadataMs)]);
 }
 async function recover(){
  if(active.size)throw Error('Recovery requires inactive receiver');
  await pool.query("UPDATE upload_items SET attempt_id=NULL,status=CASE WHEN storage_key IS NOT NULL THEN 'received' ELSE 'incomplete' END WHERE attempt_id IS NOT NULL");
  const rows=(await pool.query('SELECT id,storage_key,expected_bytes FROM upload_items WHERE storage_key IS NOT NULL')).rows;
  const referenced=new Set(rows.map(i=>i.storage_key));for(const name of await files.names())if(!referenced.has(name))await files.remove(name);
  for(const i of rows)if(!await files.exists(i.storage_key,Number(i.expected_bytes)))await transaction(pool,async c=>{
   await c.query("UPDATE upload_items SET status='incomplete',storage_key=NULL,checksum=NULL,received_bytes=0,error_code='RESOURCE_MISSING' WHERE id=$1",[i.id]);
   await c.query("UPDATE upload_sessions SET status='expired',expires_at=$2 WHERE id=(SELECT upload_id FROM upload_items WHERE id=$1) AND status='ready'",[i.id,new Date(now())]);
  });
  await cleanup();
 }
 return {create,get,receive,finalize,cleanup,recover,config,async stop(){closing=true;for(const a of active.values())a.abort();await Promise.all([...completions.values()]);},get activeCount(){return active.size;}};
}
export type Uploads=ReturnType<typeof createUploads>;
