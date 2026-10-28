import {withRequestSignal} from './request-signal.js';
import {createFontPreflightGate} from '../fonts/preflight-gate.js';
import {rendererIdentity} from '../fonts/snapshot.js';
import {readFileSync} from 'node:fs';
import {registerDocuments,type Documents} from './documents.js';
import {registerFontsAdmin,checkFontAdminAccess,type FontAdminAccess} from './fonts-admin.js';
import {fontRoot} from '../fonts/snapshot.js';
import {templateContract} from '../templates/contract.js';
import {readGenerationJson} from '@flowdoc/core';
import {buildAreaContract} from '../templates/areaContract.js';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {loadTemplate} from '../templates/registry.js';
import {DEFAULT_MAX_OUTSTANDING,validateMaxOutstanding} from '../jobs/config.js';
import {submitJob} from '../jobs/admission.js';
import {getJob,validJobId} from '../jobs/repository.js';
import type {Outputs} from '../storage/outputs.js';
import {failure,OperationError} from '../errors.js';
import type {Uploads} from '../uploads/service.js';
import {registerUploads} from './uploads.js';
import {registerAuthoring,checkAuthoringAccess,type AuthoringAccess} from './authoring.js';
const status=(code:string)=>({QUEUE_FULL:503,UNKNOWN_SECTION:422,UNKNOWN_FORMAT:422,INVALID_JOB_ID:400,INVALID_DATA:422,TYPE_MISMATCH:422,MISSING_REQUIRED:422,EMPTY_CONTENT:422,EXPANSION_LIMIT:422,IMAGE_JOBS_UNAVAILABLE:422,INVALID_UPLOAD:422,INVALID_RESOURCE:422,UPLOAD_NOT_FOUND:404,UPLOAD_GONE:410,UPLOAD_CONFLICT:409,UPLOAD_INCOMPLETE:409,TEMPLATE_NOT_FOUND:404,VERSION_NOT_FOUND:404,JOB_NOT_FOUND:404,OUTPUT_GONE:410}[code]??503);
export function createServer(deps:{pool:Pool;outputs:Outputs;isReady:()=>boolean;bodyLimit?:number;uploads?:Uploads;imagesEnabled?:boolean;maxOutstanding?:number;authoring?:AuthoringAccess;fontAdmin?:FontAdminAccess;fontStorageRoot?:string;tasks?:Documents}){
 if(deps.authoring)checkAuthoringAccess(deps.authoring);
 if(deps.fontAdmin)checkFontAdminAccess(deps.fontAdmin,deps.authoring?.token);
 const maxOutstanding=validateMaxOutstanding(deps.maxOutstanding??DEFAULT_MAX_OUTSTANDING);
 const preflight=createFontPreflightGate(deps.tasks?.intake.processingContext.resources),ready=()=>deps.isReady()&&preflight.isReady();
 const app=Fastify({logger:false,forceCloseConnections:true,bodyLimit:deps.bodyLimit??2097152});
 if(deps.authoring)app.register(async routes=>registerAuthoring(routes,{pool:deps.pool,outputs:deps.outputs,isReady:ready,preflight,maxOutstanding,imagesEnabled:deps.imagesEnabled??false,access:deps.authoring!,documents:deps.tasks?{version:1,route:'/documents',input:'section-assets-multipart-v1',response:'task-v1',lookup:'exact-record-only',queue:deps.tasks.intake.queueCapability(),serviceVersion:JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version,coreVersion:rendererIdentity.version,coreSha256:rendererIdentity.sha256}:null,...(deps.uploads?{uploads:deps.uploads}:{})}));
 app.addContentTypeParser('application/json',{parseAs:'string'},(_req,body,done)=>{
  const r=readGenerationJson(body as string);if(!r.ok){done(Object.assign(new Error('Invalid JSON'),{statusCode:400}));return;}
  const pending:unknown[]=[r.value];while(pending.length){const v=pending.pop();if(v&&typeof v==='object'){
   if(!Array.isArray(v)&&(Object.hasOwn(v,'__proto__')||(Object.hasOwn(v,'constructor')&&typeof (v as any).constructor==='object'&&(v as any).constructor!==null&&Object.hasOwn((v as any).constructor,'prototype')))){done(Object.assign(new Error('Invalid JSON'),{statusCode:400}));return;}
   pending.push(...Object.values(v));
  }}done(null,r.value);
 });
 if(deps.fontAdmin)app.register(async routes=>registerFontsAdmin(routes,{pool:deps.pool,root:deps.fontStorageRoot??fontRoot(),access:deps.fontAdmin!,isReady:deps.isReady,...(deps.authoring?{authoringToken:deps.authoring.token}:{})}));
 if(deps.uploads)app.register(async routes=>{
  routes.addHook('onRequest',async(req,reply)=>{const id=(req.params as any)?.id;if(typeof id==='string'&&validJobId(id)&&(await deps.pool.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal IS NOT NULL',[id])).rowCount)return reply.code(404).send(failure(new OperationError('UPLOAD_NOT_FOUND','uploadId','Upload not found')));});
  routes.addHook('onRequest',async(_req,reply)=>{if(!ready())return reply.code(503).send(failure(new OperationError('UNAVAILABLE','service','Service unavailable')));});
  await registerUploads(routes,deps.uploads!);
 });
 if(deps.tasks)app.register(async routes=>registerDocuments(routes,deps.pool,deps.tasks!,ready));
 app.addHook('onClose',()=>preflight.stop());
 const pending=new Set<Promise<void>>();app.addHook('onClose',async()=>{await Promise.allSettled([...pending]);});
 app.setErrorHandler((error,request,reply)=>{const e=error as {statusCode?:number};const code=e.statusCode===413?413:e.statusCode&&e.statusCode>=400&&e.statusCode<500?400:503;reply.code(code).send(failure(new OperationError(code===413?'BODY_TOO_LARGE':code===400?'INVALID_REQUEST':'UNAVAILABLE','request',code===413?'Request exceeds size limit':code===400?'Invalid request':'Service unavailable')));});
 app.get('/health',async(_req,reply)=>{try{if(!ready())throw Error();await deps.pool.query('SELECT 1');return {ok:true,value:{ready:true},warnings:[]};}catch{reply.code(503);return failure(new OperationError('UNAVAILABLE','service','Service unavailable'));}});
 app.get<{Params:{docKey:string};Querystring:{version?:string}}>('/templates/:docKey/contract',async(req,reply)=>{
  const raw=req.query.version;let version:number|undefined;
  if(raw!==undefined){if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>2147483647){reply.code(400);return failure(new OperationError('INVALID_VERSION','version','Invalid version'));}version=Number(raw);}
  const r=await loadTemplate(deps.pool,req.params.docKey,version);if(!r.ok){reply.code(status(r.issues[0]!.code));return r;}
  const t=r.value.template.definition;return {ok:true,value:templateContract(t),warnings:[]};
 });
 app.post('/jobs',async(req,reply)=>{
  if(!ready()){reply.code(503);return failure(new OperationError('UNAVAILABLE','service','Service unavailable'));}
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||typeof (req.body as Record<string,unknown>).docKey!=='string'){reply.code(400);return failure(new OperationError('INVALID_REQUEST','request','Invalid request'));}
  const r=await withRequestSignal(req,reply,signal=>submitJob(deps.pool,req.body,deps.imagesEnabled===true,maxOutstanding,{preflight,signal}));reply.code(r.ok?202:status(r.issues[0]!.code));return r;
 });
 app.get<{Params:{jobId:string}}>('/jobs/:jobId',async(req,reply)=>{
  const r=await getJob(deps.pool,req.params.jobId);if(!r.ok){reply.code(status(r.issues[0]!.code));return r;}
  const available=r.value.status==='succeeded'&&await deps.outputs.available(r.value.jobId);
  return {...r,value:{...r.value,outputAvailable:available,...(available?{downloadUrl:'/jobs/'+r.value.jobId+'/pdf'}:{})}};
 });
 app.get<{Params:{jobId:string}}>('/jobs/:jobId/pdf',async(req,reply)=>{
  const r=await getJob(deps.pool,req.params.jobId);if(!r.ok){reply.code(status(r.issues[0]!.code));return r;}
  if(r.value.status!=='succeeded'){reply.code(409);return failure(new OperationError('OUTPUT_NOT_READY','job','Job has no successful output'));}
  try{
   const lease=await deps.outputs.acquire(r.value.jobId);let ended=false,settled=false;
   let complete!:()=>void;const completion=new Promise<void>(resolve=>{complete=resolve;});pending.add(completion);
   lease.stream.once('end',()=>{ended=true;});
   const finish=(success:boolean)=>{if(settled)return;settled=true;void lease.finish(success).catch(()=>{}).finally(()=>{complete();pending.delete(completion);});};
   reply.raw.once('finish',()=>finish(ended&&reply.raw.statusCode===200));
   reply.raw.once('close',()=>{if(!reply.raw.writableFinished){lease.stream.destroy();finish(false);}});
   return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="${r.value.jobId}.pdf"`).header('Cache-Control','no-store').send(lease.stream);
  }catch(e){const result=failure(e);reply.code(result.ok?503:status(result.issues[0]!.code));return result;}
 });
 return app;
}
