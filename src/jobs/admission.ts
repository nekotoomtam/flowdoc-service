import type {Pool} from 'pg';
import {prepareGeneration} from '@flowdoc/core';
import type {Result} from '@flowdoc/core';
import {loadTemplate} from '../templates/registry.js';
import {failure,OperationError} from '../errors.js';
import type {JobReceipt} from './types.js';
export async function submitJob(pool:Pool,input:unknown):Promise<Result<JobReceipt>>{
 if(!input||typeof input!=='object'||Array.isArray(input))return failure(new OperationError('INVALID_DATA','request','Expected an object'));
 const request=input as Record<string,unknown>;
 if(typeof request.docKey!=='string'||(request.version!==undefined&&typeof request.version!=='number'))return failure(new OperationError('INVALID_DATA','request','Invalid template key or version'));
 const selected=await loadTemplate(pool,request.docKey,request.version as number|undefined);if(!selected.ok)return selected;
 const prepared=prepareGeneration(selected.value.template,input);if(!prepared.ok)return prepared;
 try{
  const p=prepared.value;
  const row=await pool.query<{id:string}>('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES(uuidv7(),$1,$2,$3,$4,$5) RETURNING id',[selected.value.versionId,JSON.stringify(input),JSON.stringify(p),JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices)]);
  return {ok:true,value:{jobId:row.rows[0]!.id,version:p.template.version,status:'queued',hasWarnings:p.warnings.length>0,warnings:p.warnings,skippedContentIndices:p.skippedContentIndices},warnings:p.warnings};
 }catch(error){return failure(error);}
}
