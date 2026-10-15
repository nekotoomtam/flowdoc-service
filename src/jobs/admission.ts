import {imageNodes as collectImageNodes} from '../images/nodes.js';
import type {Pool} from 'pg';
import {prepareGeneration,composeDocument} from '@flowdoc/core';
import type {Result} from '@flowdoc/core';
import {loadTemplate} from '../templates/registry.js';
import {failure,OperationError} from '../errors.js';
import type {JobReceipt} from './types.js';
import {enqueueWithUpload} from '../uploads/claims.js';
import {getJob} from './repository.js';
import {transaction} from '../db/connection.js';
import {reserveJobCapacity} from './capacity.js';
import {DEFAULT_MAX_OUTSTANDING,validateMaxOutstanding} from './config.js';
export async function submitJob(pool:Pool,input:unknown,imagesEnabled=false,maxOutstanding=DEFAULT_MAX_OUTSTANDING):Promise<Result<JobReceipt>>{
 validateMaxOutstanding(maxOutstanding);
 if(!input||typeof input!=='object'||Array.isArray(input))return failure(new OperationError('INVALID_DATA','request','Expected an object'));
 const request=input as Record<string,unknown>;
 if(typeof request.docKey!=='string'||(request.version!==undefined&&typeof request.version!=='number'))return failure(new OperationError('INVALID_DATA','request','Invalid template key or version'));
 const selected=await loadTemplate(pool,request.docKey,request.version as number|undefined);if(!selected.ok)return selected;
 const {uploadId,...coreInput}=request;
 const prepared=prepareGeneration(selected.value.template,coreInput);if(!prepared.ok)return prepared;
 const document=composeDocument(selected.value.template,prepared.value);if(!document.ok)return document;
 const imageNodes=collectImageNodes(document.value);
 if(imageNodes.length&&!imagesEnabled)
  return failure(new OperationError('IMAGE_JOBS_UNAVAILABLE','content','Image resource claiming is not connected yet'));
 try{
  const p=prepared.value;
  if(imageNodes.length||uploadId!==undefined){
   const ids=imageNodes.map(n=>n.props.resourceId).filter(Boolean);
   if(ids.length||uploadId!==undefined){
    if(typeof uploadId!=='string')throw new OperationError('INVALID_UPLOAD','uploadId','A finalized upload is required');
    if(/^[0-9a-f-]{36}$/i.test(uploadId)&&(await pool.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal IS NOT NULL',[uploadId])).rowCount)throw new OperationError('UPLOAD_NOT_FOUND','uploadId','Upload not found');
    const claimed=await enqueueWithUpload(pool,{uploadId,versionId:selected.value.versionId,originalInput:input,preparedInput:p,resourceIds:ids},Date.now(),maxOutstanding);
    return getJob(pool,claimed.jobId);
   }
  }
  const row=await transaction(pool,async c=>{
   await reserveJobCapacity(c,maxOutstanding);
   return c.query<{id:string}>('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES(uuidv7(),$1,$2,$3,$4,$5) RETURNING id',[selected.value.versionId,JSON.stringify(input),JSON.stringify(p),JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices)]);
  });
  return {ok:true,value:{jobId:row.rows[0]!.id,version:p.template.version,status:'queued',hasWarnings:p.warnings.length>0,warnings:p.warnings,skippedContentIndices:p.skippedContentIndices},warnings:p.warnings};
 }catch(error){return failure(error);}
}
