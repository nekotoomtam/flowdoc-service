import type {Pool,PoolClient} from 'pg';
import {validateTemplate} from '@flowdoc/core';
import type {Result} from '@flowdoc/core';
import type {CurrentRecord} from './assembly.js';
import {checkRecord,normalizeAreaDeletions} from './assembly.js';
import {freshRecord,readRecord,writeCurrent} from './storage.js';
import {transaction} from '../db/connection.js';
import {OperationError,failure} from '../errors.js';
export async function lockTemplate(c:PoolClient,id:string){const q=await c.query('SELECT id,doc_key FROM templates WHERE id=$1 FOR UPDATE',[id]);if(!q.rows.length)throw new OperationError('TEMPLATE_NOT_FOUND','templateId','Template not found');return q.rows[0];}
export async function importCurrent(pool:Pool,rawJson:string):Promise<Result<CurrentRecord>>{
 const valid=validateTemplate(rawJson);if(!valid.ok)return valid;
 try{return {ok:true,value:await transaction(pool,async c=>{
  const t=valid.value.definition;
  await c.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[t.templateId,t.docKey,t.name]);
  const matches=await c.query('SELECT id,doc_key FROM templates WHERE id=$1 OR doc_key=$2 ORDER BY id FOR UPDATE',[t.templateId,t.docKey]);
  if(matches.rows.length!==1||matches.rows[0].id!==t.templateId)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','template','Identity conflict');
  const identity=matches.rows[0];
  if(identity.doc_key!==t.docKey)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','template','Identity conflict');
  if((await c.query('SELECT 1 FROM template_current WHERE template_id=$1',[t.templateId])).rowCount)throw new OperationError('CURRENT_EXISTS','template','Use ID-bearing draft-save to update current');
  await writeCurrent(c,await freshRecord(c,t));return readRecord(c,t.templateId);
 }),warnings:[]};}catch(e){return failure(e);}
}
export async function loadCurrent(pool:Pool,templateId:string):Promise<Result<CurrentRecord>>{try{return {ok:true,value:await transaction(pool,async c=>{await lockTemplate(c,templateId);return readRecord(c,templateId);}),warnings:[]};}catch(e){return failure(e);}}
export async function saveCurrent(pool:Pool,record:CurrentRecord,expectedRevision:number):Promise<Result<CurrentRecord>>{
 try{return {ok:true,value:await transaction(pool,async c=>{
 const t=await lockTemplate(c,record.templateId);if(t.doc_key!==record.payload.docKey)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','docKey','Identity cannot change');
 const existing=await readRecord(c,record.templateId);if(existing.revision!==expectedRevision)throw new OperationError('STALE_CURRENT','revision','Reload current before saving');
 record=normalizeAreaDeletions(existing,record);checkRecord(record);
 if(existing.revision>=2147483647)throw new OperationError('REVISION_LIMIT','revision','Revision limit reached');
 // Existing IDs may not be moved between entity kinds or owners.
 const owned=new Map<string,string>();for(const f of existing.formats)owned.set(f.id,'format:'+(f.ownerAreaVariableId??''));for(const s of existing.schemas)owned.set(s.id,'schema:'+s.formatId);for(const v of existing.variables)owned.set(v.id,'variable:'+v.schemaId);
 for(const [rows,kind] of [[record.formats,'format'],[record.schemas,'schema'],[record.variables,'variable']] as const)for(const row of rows){const target=kind==='format'?'format:'+((row as any).ownerAreaVariableId??''):kind==='schema'?'schema:'+(row as any).formatId:'variable:'+(row as any).schemaId;if(owned.has(row.id)&&owned.get(row.id)!==target)throw new OperationError('INVALID_DATA','id','Cannot move existing identity between owners');}
 await writeCurrent(c,record);return readRecord(c,record.templateId);
 }),warnings:[]};}catch(e){return failure(e);}
}
