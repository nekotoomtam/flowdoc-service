import {checkFontReadiness,resolveFontReadiness} from '../fonts/readiness.js';
import {readReferences,verifyReferences,writeReferences} from '../fonts/retention.js';
import {persistJobFonts} from '../fonts/snapshot.js';
import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {assemble} from '../templates/assembly.js';
import {readRecord,writeCurrent} from '../templates/storage.js';
import {reconcileDefinition} from './adapter.js';
import {failure,OperationError} from '../errors.js';
import {imageNodes} from '../images/nodes.js';
import {validJobId} from '../jobs/repository.js';
import {reserveJobCapacity} from '../jobs/capacity.js';
import {enqueueWithUploadInTransaction} from '../uploads/claims.js';

const invalid=(path:string,message='Invalid authoring input'):never=>{throw new OperationError('INVALID_DATA',path,message);};
export function object(value:unknown):Record<string,any>{if(!value||typeof value!=='object'||Array.isArray(value))return invalid('request');return value as Record<string,any>;}
export function fields(value:unknown,allowed:string[]){const v=object(value);if(Object.keys(v).some(k=>!allowed.includes(k)))invalid('request','Unknown authoring field');return v;}
function canonical(v:any):string{return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
async function owned(c:PoolClient,principal:string,id:string){const r=await c.query('SELECT t.* FROM templates t JOIN authoring_templates a ON a.template_id=t.id WHERE t.id=$1 AND a.principal=$2 FOR UPDATE OF t',[id,principal]);if(!r.rows[0])throw new OperationError('TEMPLATE_NOT_FOUND','templateId','Draft not found');return r.rows[0];}
async function view(c:PoolClient,id:string){
 const t=(await c.query('SELECT id,doc_key,name FROM templates WHERE id=$1',[id])).rows[0];
 const current=(await c.query('SELECT revision FROM template_current WHERE template_id=$1',[id])).rows[0];
 if(!current)return {templateId:id,docKey:t.doc_key,name:t.name,revision:0,state:'empty',definition:null,fingerprint:null};
 const definition=assemble(await readRecord(c,id),1),v=validateTemplate(definition);if(!v.ok)throw new OperationError('STORAGE_FAILED','draft','Stored draft failed validation');
 const refs=await readReferences(c,id,current.revision);
 const fontReadiness=await checkFontReadiness(c,definition,v.value.fingerprint,refs);
 if(definition.schemaVersion===2&&(!refs||refs.definitionFingerprint!==v.value.fingerprint)){fontReadiness.status='incomplete';fontReadiness.issues=[{code:'FONT_CHECK_UNAVAILABLE',path:'/font',message:'Reference provenance is unavailable',remedy:'Restore the verified reference set',styleIds:[],occurrences:[],samples:[],total:1,truncated:false}];fontReadiness.total=1;}
 return {templateId:id,docKey:t.doc_key,name:definition.name,revision:current.revision,state:'ready',definition,fingerprint:v.value.fingerprint,fontReadiness};
}
async function receipt(c:PoolClient,principal:string,operation:string,target:string,input:any,run:()=>Promise<any>){
 if(typeof input.idempotencyKey!=='string'||input.idempotencyKey.length<1||input.idempotencyKey.length>200)invalid('idempotencyKey');
 const digest=createHash('sha256').update(canonical(input)).digest('hex');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([principal,operation,target,input.idempotencyKey])]);
 const old=(await c.query('SELECT digest,result FROM authoring_receipts WHERE principal=$1 AND operation=$2 AND target=$3 AND request_key=$4',[principal,operation,target,input.idempotencyKey])).rows[0];
 if(old){if(old.digest!==digest)throw new OperationError('IDEMPOTENCY_CONFLICT','idempotencyKey','Key already used for different input');return old.result;}
 const result=await run();await c.query('INSERT INTO authoring_receipts(principal,operation,target,request_key,digest,result) VALUES($1,$2,$3,$4,$5,$6)',[principal,operation,target,input.idempotencyKey,digest,JSON.stringify(result)]);return result;
}
const revision=(expected:unknown,actual:number)=>{if(!Number.isSafeInteger(expected)||Number(expected)<0)invalid('expectedRevision');if(expected!==actual)throw new OperationError('STALE_CURRENT','expectedRevision','Reload draft before saving or previewing');};
const audit=(c:PoolClient,id:string,p:string,r:number,op:string,summary:unknown)=>c.query('INSERT INTO authoring_audit(template_id,principal,revision,operation,summary) VALUES($1,$2,$3,$4,$5)',[id,p,r,op,JSON.stringify(summary)]);
export function definitionDiff(before:any,after:any){
 const diff:{path:string;change:string}[]=[];
 const visit=(a:any,b:any,path:string)=>{
  if(diff.length>200||canonical(a??null)===canonical(b??null))return;
  if(Array.isArray(a)&&Array.isArray(b)){
   const keyed=[...a,...b].every(v=>v&&typeof v==='object'&&typeof v.id==='string');
   if(keyed){const left=Object.fromEntries(a.map(v=>[v.id,v])),right=Object.fromEntries(b.map(v=>[v.id,v]));visit(left,right,path);
    if(diff.length<=200&&a.map(v=>v.id).join('\0')!==b.map(v=>v.id).join('\0'))diff.push({path:path+'.$order',change:'changed'});
   }else for(let i=0;i<Math.max(a.length,b.length)&&diff.length<=200;i++)visit(a[i],b[i],path+'.'+i);
  }else if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
   for(const k of new Set([...Object.keys(a),...Object.keys(b)])){visit(a[k],b[k],path?path+'.'+k:k);if(diff.length>200)break;}
  }else diff.push({path,change:a===undefined?'added':b===undefined?'removed':'changed'});
 };
 visit(before,after,'');return {diff:diff.slice(0,200),diffLimit:200,diffTruncated:diff.length>200};
}
export function createAuthoring(pool:Pool,principal:string,options:{maxOutstanding:number;imagesEnabled:boolean}){
 const safe=async(fn:()=>Promise<any>)=>{try{return {ok:true as const,value:await fn(),warnings:[]};}catch(e){return e instanceof AuthoringIssues?e.result:failure(e);}};
 return {
  create:(raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['name','docKey','idempotencyKey']);
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200||typeof input.docKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.docKey))invalid('name/docKey');
   return receipt(c,principal,'create','',input,async()=>{
    const id=randomUUID();const created=await c.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[id,input.docKey,input.name]);
    if(!created.rowCount)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','docKey','Document key already exists');
    await c.query('INSERT INTO authoring_templates(template_id,principal) VALUES($1,$2)',[id,principal]);await audit(c,id,principal,0,'create',{});return view(c,id);
   });
  })),
  get:(id:string)=>safe(()=>transaction(pool,async c=>{await owned(c,principal,id);return view(c,id);})),
  save:(id:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['definition','expectedRevision','idempotencyKey']);const identity=await owned(c,principal,id);
   return receipt(c,principal,'save',id,input,async()=>{
    const before=await view(c,id);revision(input.expectedRevision,before.revision);
    const v=validateTemplate(input.definition);if(!v.ok)throw new AuthoringIssues(v);
    if(v.value.definition.nodeModelVersion!==18)invalid('nodeModelVersion','Authoring supports Area18 only');
    if(v.value.definition.templateId!==id||v.value.definition.docKey!==identity.doc_key||v.value.definition.version!==1)invalid('definition','Identity must match the created draft; draft definition version is 1');
    const previous=before.revision?await readRecord(c,id):undefined;
    await writeCurrent(c,reconcileDefinition(v.value.definition,previous));
    await c.query('UPDATE templates SET name=$2,updated_at=now() WHERE id=$1',[id,v.value.definition.name]);
    const after=await view(c,id),difference=definitionDiff(before.definition,after.definition);await audit(c,id,principal,after.revision,'save',difference);return {...after,...difference};
   });
  })),
  cloneDraft:(id:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['sourceRevision','name','docKey','idempotencyKey']);await owned(c,principal,id);
   return receipt(c,principal,'clone',id,input,async()=>{
    const source=await view(c,id);revision(input.sourceRevision,source.revision);if(!source.definition)throw new OperationError('DRAFT_EMPTY','draft','Save a definition before cloning');
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>200||typeof input.docKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.docKey))invalid('name/docKey');
    const refs=await readReferences(c,id,source.revision);verifyReferences(source.definition,source.fingerprint!,refs);
    const target=randomUUID(),created=await c.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[target,input.docKey,input.name]);
    if(!created.rowCount)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','docKey','Document key already exists');
    await c.query('INSERT INTO authoring_templates(template_id,principal) VALUES($1,$2)',[target,principal]);
    const definition={...structuredClone(source.definition),templateId:target,docKey:input.docKey,name:input.name,version:1};
    const valid=validateTemplate(definition);if(!valid.ok)throw new AuthoringIssues(valid);
    await writeCurrent(c,reconcileDefinition(valid.value.definition),refs);
    await audit(c,target,principal,1,'clone',{sourceId:id,sourceRevision:source.revision,sourceReferenceSetId:refs?.id??null});return view(c,target);
   });
  })),
  fontReadiness:(id:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['expectedRevision','sampleRequest']);await owned(c,principal,id);const draft=await view(c,id);revision(input.expectedRevision,draft.revision);
   if(!draft.definition)throw new OperationError('DRAFT_EMPTY','draft','Save a definition before checking fonts');
   const v=validateTemplate(draft.definition);if(!v.ok)throw new AuthoringIssues(v);const refs=await readReferences(c,id,draft.revision);verifyReferences(draft.definition,draft.fingerprint!,refs);
   let actual;
   if(input.sampleRequest!==undefined){const request=object(input.sampleRequest),{uploadId,...coreInput}=request;const p=prepareGeneration(v.value,coreInput);if(!p.ok)throw new AuthoringIssues(p);const d=composeDocument(v.value,p.value);if(!d.ok)throw new AuthoringIssues(d);actual={document:d.value,input:request};}
   return {templateId:id,revision:draft.revision,fontReadiness:await checkFontReadiness(c,draft.definition,draft.fingerprint!,refs,actual)};
  })),
  validate:async(raw:unknown)=>{const warnings:import('@flowdoc/core').Issue[]=[];const result=await safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['definition','sampleRequest']),v=validateTemplate(input.definition);if(!v.ok)throw new AuthoringIssues(v);if(v.value.definition.nodeModelVersion!==18)invalid('nodeModelVersion');
   let refs=null;
   const owner=(await c.query('SELECT 1 FROM authoring_templates WHERE template_id=$1 AND principal=$2',[v.value.definition.templateId,principal])).rowCount;
   if(owner){const saved=await view(c,v.value.definition.templateId);refs=await readReferences(c,saved.templateId,saved.revision);if(saved.definition)verifyReferences(saved.definition,saved.fingerprint!,refs);if(refs)refs={...refs,definitionFingerprint:v.value.fingerprint};}
   if(input.sampleRequest!==undefined){const p=prepareGeneration(v.value,input.sampleRequest);if(!p.ok)throw new AuthoringIssues(p);const d=composeDocument(v.value,p.value);if(!d.ok)throw new AuthoringIssues(d);warnings.push(...p.warnings,...d.warnings);return {fingerprint:v.value.fingerprint,composed:true,fontReadiness:await checkFontReadiness(c,v.value.definition,v.value.fingerprint,refs,{document:d.value,input:input.sampleRequest})};}
   return {fingerprint:v.value.fingerprint,composed:false,fontReadiness:await checkFontReadiness(c,v.value.definition,v.value.fingerprint,refs)};
  }));return result.ok?{...result,warnings}:result;},
  preview:(id:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const input=fields(raw,['expectedRevision','sampleRequest','idempotencyKey']);await owned(c,principal,id);
   return receipt(c,principal,'preview',id,input,async()=>{
    const draft=await view(c,id);revision(input.expectedRevision,draft.revision);if(!draft.definition)throw new OperationError('DRAFT_EMPTY','draft','Save a complete definition before preview');
    const v=validateTemplate(draft.definition);if(!v.ok)throw new AuthoringIssues(v);
    const request=object(input.sampleRequest),{uploadId,...coreInput}=request;
    const p=prepareGeneration(v.value,coreInput);if(!p.ok)throw new AuthoringIssues(p);const d=composeDocument(v.value,p.value);if(!d.ok)throw new AuthoringIssues(d);
    const retained=await readReferences(c,id,draft.revision);verifyReferences(draft.definition,draft.fingerprint!,retained);
    const releaseIds=[...new Set(Object.values(draft.definition.styles).flatMap((s:any)=>s.font?.kind==='library'?[s.font.releaseId]:[]))].sort();
    if(releaseIds.length)await c.query('SELECT id FROM font_releases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[releaseIds]);
    const fonts=await resolveFontReadiness(c,draft.definition,draft.fingerprint!,retained,{document:d.value,input:request});
    if(!fonts.snapshot)throw new AuthoringIssues({ok:false,issues:fonts.readiness.issues,warnings:[]});
    const refs=imageNodes(d.value).map(n=>n.props.resourceId).filter(Boolean);
    const pin={templateId:id,revision:draft.revision,definition:draft.definition,fingerprint:draft.fingerprint!};let jobId:string;
    if(refs.length||uploadId!==undefined){
     if(!options.imagesEnabled)throw new OperationError('IMAGE_JOBS_UNAVAILABLE','images','Image preparation unavailable');
     if(typeof uploadId!=='string')invalid('uploadId','A fresh finalized upload is required');
     if(!validJobId(uploadId)||(await c.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal=$2',[uploadId,principal])).rowCount!==1)throw new OperationError('UPLOAD_NOT_FOUND','uploadId','Authoring upload not found');
     jobId=(await enqueueWithUploadInTransaction(c,{uploadId,versionId:null,originalInput:request,preparedInput:p.value,resourceIds:refs,preview:pin},Date.now(),options.maxOutstanding)).jobId;
    }else{
     await reserveJobCapacity(c,options.maxOutstanding);
     jobId=(await c.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices,preview_template_id,preview_revision,preview_definition,preview_fingerprint) VALUES(uuidv7(),NULL,$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[JSON.stringify(request),JSON.stringify(p.value),JSON.stringify(p.warnings),JSON.stringify(p.value.skippedContentIndices),id,draft.revision,JSON.stringify(draft.definition),draft.fingerprint])).rows[0].id;
    }
    await persistJobFonts(c,jobId,fonts.snapshot);
    await audit(c,id,principal,draft.revision,'preview',{jobId,fingerprint:draft.fingerprint});return {jobId,templateId:id,revision:draft.revision,fingerprint:draft.fingerprint,status:'queued',warnings:p.warnings};
   });
  })),
  async previewOwner(jobId:string){if(!validJobId(jobId))return null;const r=await pool.query('SELECT j.preview_template_id,j.preview_revision,j.preview_fingerprint FROM generation_jobs j JOIN authoring_templates a ON a.template_id=j.preview_template_id WHERE j.id=$1 AND a.principal=$2',[jobId,principal]);return r.rows[0]??null;}
 };
}
class AuthoringIssues extends OperationError {constructor(public result:any){super(result.issues[0]?.code??'INVALID_DATA',result.issues[0]?.path??'request',result.issues[0]?.message??'Invalid authoring input');}}
