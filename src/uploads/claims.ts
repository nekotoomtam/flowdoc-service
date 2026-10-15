import type {Pool,PoolClient} from 'pg';
import type {PreparedInput} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {OperationError} from '../errors.js';
import {validJobId} from '../jobs/repository.js';
import {reserveJobCapacity} from '../jobs/capacity.js';
import {DEFAULT_MAX_OUTSTANDING,validateMaxOutstanding} from '../jobs/config.js';

interface UploadJobInput {
 uploadId:string; versionId:string|null; originalInput:unknown; preparedInput:PreparedInput;
 preview?:{templateId:string;revision:number;definition:unknown;fingerprint:string};
 // Trusted caller derives these from the composed image nodes, never raw client metadata.
 resourceIds:string[];
}
const error=(code:string,message:string)=>new OperationError(code,'uploadId',message);
/** Internal admission boundary; image HTTP admission remains gated until rendering is wired. */
export async function enqueueWithUpload(pool:Pool,input:UploadJobInput,now=Date.now(),maxOutstanding=DEFAULT_MAX_OUTSTANDING):Promise<{jobId:string;created:boolean}>{
 return transaction(pool,c=>enqueueWithUploadInTransaction(c,input,now,maxOutstanding));
}
export async function enqueueWithUploadInTransaction(c:PoolClient,input:UploadJobInput,now=Date.now(),maxOutstanding=DEFAULT_MAX_OUTSTANDING):Promise<{jobId:string;created:boolean}>{
 validateMaxOutstanding(maxOutstanding);
 if(!validJobId(input.uploadId))throw error('INVALID_UPLOAD','Invalid upload ID');
 if(input.resourceIds.some(id=>!validJobId(id)))throw error('INVALID_RESOURCE','Invalid resource reference');
 const ids=[...new Set(input.resourceIds.map(id=>id.toLowerCase()))].sort();
 const original=JSON.stringify(input.originalInput),prepared=JSON.stringify(input.preparedInput),refs=JSON.stringify(ids);
  const s=(await c.query('SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE',[input.uploadId])).rows[0];
  if(!s)throw error('UPLOAD_NOT_FOUND','Upload not found');
  if(s.status==='expired'||s.deleted_at)throw error('UPLOAD_GONE','Upload expired');
  const existing=(await c.query(`SELECT j.id,j.status,j.finished_at,
   j.template_version_id IS NOT DISTINCT FROM $2::uuid AND j.original_input=$3::jsonb AND j.prepared_input=$4::jsonb AND u.resource_ids=$5::jsonb
   AND j.preview_template_id IS NOT DISTINCT FROM $6::text AND j.preview_revision IS NOT DISTINCT FROM $7::integer AS identical
   FROM upload_job_claims u JOIN generation_jobs j ON j.id=u.job_id WHERE u.upload_id=$1`,[input.uploadId,input.versionId,original,prepared,refs,input.preview?.templateId??null,input.preview?.revision??null])).rows[0];
  if(existing){
   if(existing.finished_at&&+new Date(existing.finished_at)+3600000<=now)throw error('UPLOAD_GONE','Upload expired');
   if(!existing.identical)throw error('UPLOAD_CONFLICT','Upload already belongs to another request');
   return {jobId:existing.id,created:false};
  }
  if(+new Date(s.expires_at)<=now)throw error('UPLOAD_GONE','Upload expired');
  if(s.status!=='ready')throw error('UPLOAD_INCOMPLETE','Finalize the upload before submitting a job');
  const items=(await c.query('SELECT id,status,source_kind,storage_key FROM upload_items WHERE upload_id=$1 AND id=ANY($2::uuid[])',[input.uploadId,ids])).rows;
  if(items.length!==ids.length||items.some(i=>i.source_kind==='upload'?i.status!=='received'||!i.storage_key:i.status!=='declared'))
   throw error('INVALID_RESOURCE','Resource does not belong to the finalized upload');
  const p=input.preparedInput;
  await reserveJobCapacity(c,maxOutstanding);
  const pin=input.preview;
  const jobId=(await c.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices,preview_template_id,preview_revision,preview_definition,preview_fingerprint) VALUES(uuidv7(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[input.versionId,original,prepared,JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices),pin?.templateId??null,pin?.revision??null,pin?JSON.stringify(pin.definition):null,pin?.fingerprint??null])).rows[0].id;
  await c.query('INSERT INTO upload_job_claims(upload_id,job_id,resource_ids) VALUES($1,$2,$3)',[input.uploadId,jobId,refs]);
  return {jobId,created:true};
}
