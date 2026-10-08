import type {Pool} from 'pg';
import {validateTemplate} from '@flowdoc/core';
import type {Result,ValidatedTemplate} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {OperationError,failure} from '../errors.js';
import {freshRecord,writeCurrent,writeSnapshot,verifySnapshot} from './storage.js';
export interface Registration {templateId:string;docKey:string;version:number;versionId:string;fingerprint:string;created:boolean}
export interface SelectedTemplate {versionId:string;template:ValidatedTemplate}
export async function registerTemplate(pool:Pool,rawJson:string):Promise<Result<Registration>>{
 if(typeof rawJson!=='string')return failure(new OperationError('INVALID_TEMPLATE','template','Registration requires raw JSON text'));
 const valid=validateTemplate(rawJson);if(!valid.ok)return valid;
 const {definition:t,fingerprint}=valid.value;
 if(!Number.isSafeInteger(t.version)||t.version>2147483647)return failure(new OperationError('INVALID_TEMPLATE','version','Version must be an integer from 1 to 2147483647'));
 try{
  const value=await transaction(pool,async client=>{
   await client.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[t.templateId,t.docKey,t.name]);
   const identity=await client.query<{id:string;doc_key:string}>('SELECT id,doc_key FROM templates WHERE id=$1 OR doc_key=$2 ORDER BY id FOR UPDATE',[t.templateId,t.docKey]);
   if(identity.rows.length!==1||identity.rows[0]!.id!==t.templateId||identity.rows[0]!.doc_key!==t.docKey)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','template','Template ID and key belong to different identities');
   const inserted=await client.query<{id:string}>('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES(uuidv7(),$1,$2,$3,$4) ON CONFLICT(template_id,version) DO NOTHING RETURNING id',[t.templateId,t.version,JSON.stringify(t),fingerprint]);
   let versionId=inserted.rows[0]?.id;
   if(!versionId){const existing=await client.query<{id:string;fingerprint:string}>('SELECT id,fingerprint FROM template_versions WHERE template_id=$1 AND version=$2',[t.templateId,t.version]);if(existing.rows[0]?.fingerprint!==fingerprint)throw new OperationError('TEMPLATE_VERSION_CONFLICT','version','Registered version has different content');versionId=existing.rows[0]!.id;}
   if(inserted.rowCount===1){const record=await freshRecord(client,t);await writeSnapshot(client,record,versionId,true);if(!(await client.query('SELECT 1 FROM template_current WHERE template_id=$1',[t.templateId])).rowCount)await writeCurrent(client,record);}
   return {templateId:t.templateId,docKey:t.docKey,version:t.version,versionId,fingerprint,created:inserted.rowCount===1};
  });return {ok:true,value,warnings:[]};
 }catch(error){return failure(error);}
}
export async function loadTemplate(pool:Pool,docKey:string,version?:number):Promise<Result<SelectedTemplate>>{
 if(typeof docKey!=='string'||!docKey.trim()||(version!==undefined&&(!Number.isSafeInteger(version)||version<1||version>2147483647)))return failure(new OperationError('INVALID_DATA','template','Invalid template key or version'));
 try{
  const found=await pool.query<{id:string|null;definition_json:unknown;fingerprint:string}>(`SELECT v.id,v.definition_json,v.fingerprint FROM templates t LEFT JOIN LATERAL
   (SELECT id,definition_json,fingerprint FROM template_versions WHERE template_id=t.id AND ($2::integer IS NULL OR version=$2) ORDER BY version DESC LIMIT 1) v ON true WHERE t.doc_key=$1`,[docKey,version??null]);
  if(!found.rows.length)throw new OperationError('TEMPLATE_NOT_FOUND','docKey','Template not found');
  const row=found.rows[0]!;if(!row.id)throw new OperationError('VERSION_NOT_FOUND','version','Template version not found');
  const valid=validateTemplate(row.definition_json);if(!valid.ok||valid.value.fingerprint!==row.fingerprint)throw new OperationError('STORAGE_FAILED','template','Stored template failed validation');
  const template=await transaction(pool,c=>verifySnapshot(c,row.id!,valid.value.definition.version,row.fingerprint));
  return {ok:true,value:{versionId:row.id,template},warnings:[]};
 }catch(error){return failure(error);}
}
