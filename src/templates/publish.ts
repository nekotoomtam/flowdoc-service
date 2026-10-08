import type {Pool} from 'pg';
import {validateTemplate} from '@flowdoc/core';
import type {Result} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {OperationError,failure} from '../errors.js';
import {lockTemplate} from './current.js';
import {assemble} from './assembly.js';
import {readRecord,writeSnapshot} from './storage.js';
import type {Registration} from './registry.js';
export async function publishCurrent(pool:Pool,command:{templateId:string;requestId:string}):Promise<Result<Registration>>{
 if(!command||typeof command.templateId!=='string'||typeof command.requestId!=='string'||!command.requestId.trim()||command.requestId.length>200)return failure(new OperationError('INVALID_ARGUMENT','requestId','A nonempty request ID up to 200 characters is required'));
 try{return {ok:true,value:await transaction(pool,async c=>{
 const identity=await lockTemplate(c,command.templateId);
 const prior=(await c.query('SELECT v.id,v.version,v.fingerprint FROM publication_receipts r JOIN template_versions v ON v.id=r.version_id WHERE r.template_id=$1 AND r.request_id=$2',[command.templateId,command.requestId])).rows[0];
 if(prior)return {templateId:command.templateId,docKey:identity.doc_key,version:prior.version,versionId:prior.id,fingerprint:prior.fingerprint,created:false};
 const version=Number((await c.query('SELECT COALESCE(MAX(version),0)+1 AS next FROM template_versions WHERE template_id=$1',[command.templateId])).rows[0].next);
 if(version>2147483647)throw new OperationError('VERSION_LIMIT','version','Version limit reached');
 const current=await readRecord(c,command.templateId),valid=validateTemplate(assemble(current,version));if(!valid.ok)throw new OperationError('INVALID_TEMPLATE',valid.issues[0]?.path??'template','Current template is not ready: '+valid.issues.map(x=>x.path).join(', '));
 const id=(await c.query('SELECT uuidv7() AS id')).rows[0].id;
 await c.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,$3,$4,$5)',[id,command.templateId,version,JSON.stringify(valid.value.definition),valid.value.fingerprint]);
 await writeSnapshot(c,current,id);
 await c.query('INSERT INTO publication_receipts(template_id,request_id,version_id) VALUES($1,$2,$3)',[command.templateId,command.requestId,id]);
 return {templateId:command.templateId,docKey:identity.doc_key,version,versionId:id,fingerprint:valid.value.fingerprint,created:true};
 }),warnings:[]};}catch(e){return failure(e);}
}
