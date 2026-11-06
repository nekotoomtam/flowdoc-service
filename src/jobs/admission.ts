import {defaultFontPreflightGate,type FontPreflightGate} from '../fonts/preflight-gate.js';
import {readReferences,verifyReferences} from '../fonts/retention.js';
import {resolveFontReadiness} from '../fonts/readiness.js';
import {persistJobFonts} from '../fonts/snapshot.js';
import {imageNodes as collectImageNodes} from '../images/nodes.js';
import type {Pool} from 'pg';
import {prepareGeneration,composeDocument} from '@flowdoc/core';
import type {Result} from '@flowdoc/core';
import {loadTemplate} from '../templates/registry.js';
import {failure,OperationError,IssueError} from '../errors.js';
import type {JobReceipt} from './types.js';
import {enqueueWithUploadInTransaction,findUploadJobReplayInTransaction} from '../uploads/claims.js';
import {getJob} from './repository.js';
import {transaction} from '../db/connection.js';
import {reserveJobCapacity,checkJobCapacity} from './capacity.js';
import {DEFAULT_MAX_OUTSTANDING,validateMaxOutstanding} from './config.js';
async function submitAdmittedJob(pool:Pool,input:unknown,imagesEnabled=false,maxOutstanding=DEFAULT_MAX_OUTSTANDING,options:{preflight?:FontPreflightGate;signal?:AbortSignal}={}):Promise<Result<JobReceipt>>{
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
  const jobId=await transaction(pool,async c=>{
   const ids=imageNodes.map(n=>n.props.resourceId).filter(Boolean);
   if(ids.length||uploadId!==undefined){
    if(typeof uploadId!=='string')throw new OperationError('INVALID_UPLOAD','uploadId','A finalized upload is required');
    if(/^[0-9a-f-]{36}$/i.test(uploadId)&&(await c.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal IS NOT NULL',[uploadId])).rowCount)throw new OperationError('UPLOAD_NOT_FOUND','uploadId','Upload not found');
    const replay=await findUploadJobReplayInTransaction(c,{uploadId,versionId:selected.value.versionId,originalInput:input,preparedInput:p,resourceIds:ids});if(replay)return replay.jobId;
   }
   if(options.signal?.aborted)throw new OperationError('UNAVAILABLE','font','Native font check unavailable; retry later');
   await checkJobCapacity(c,maxOutstanding);
   const refs=await readReferences(c,selected.value.template.definition.templateId,0,selected.value.versionId);
   verifyReferences(selected.value.template.definition,selected.value.template.fingerprint,refs);
   const releaseIds=[...new Set(Object.values(selected.value.template.definition.styles).flatMap((s:any)=>s.font?.kind==='library'?[s.font.releaseId]:[]))].sort();
   if(releaseIds.length)await c.query('SELECT id FROM font_releases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[releaseIds]);
   const fonts=await resolveFontReadiness(c,selected.value.template.definition,selected.value.template.fingerprint,refs,{document:document.value,input},undefined,options);
   if(!fonts.snapshot)throw new IssueError(fonts.readiness.issues);
   let id:string;
   if(ids.length||uploadId!==undefined){
    if(typeof uploadId!=='string')throw new OperationError('INVALID_UPLOAD','uploadId','A finalized upload is required');
    if(/^[0-9a-f-]{36}$/i.test(uploadId)&&(await c.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal IS NOT NULL',[uploadId])).rowCount)throw new OperationError('UPLOAD_NOT_FOUND','uploadId','Upload not found');
    const claim=await enqueueWithUploadInTransaction(c,{uploadId,versionId:selected.value.versionId,originalInput:input,preparedInput:p,resourceIds:ids},Date.now(),maxOutstanding);
    if(!claim.created)return claim.jobId;id=claim.jobId;
   }else{
    await reserveJobCapacity(c,maxOutstanding);
    id=(await c.query<{id:string}>('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES(uuidv7(),$1,$2,$3,$4,$5) RETURNING id',[selected.value.versionId,JSON.stringify(input),JSON.stringify(p),JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices)])).rows[0]!.id;
   }
   await persistJobFonts(c,id,fonts.snapshot);return id;
  });
  return getJob(pool,jobId);
 }catch(error){return failure(error);}
}

export async function submitJob(pool:Pool,input:unknown,imagesEnabled=false,maxOutstanding=DEFAULT_MAX_OUTSTANDING,options:{preflight?:FontPreflightGate;signal?:AbortSignal}={}):Promise<Result<JobReceipt>>{
 validateMaxOutstanding(maxOutstanding);try{return await(options.preflight??defaultFontPreflightGate).admit(options.signal,maxOutstanding,()=>submitAdmittedJob(pool,input,imagesEnabled,maxOutstanding,options));}catch(e){return failure(e);}
}
