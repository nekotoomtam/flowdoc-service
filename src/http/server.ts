import Fastify from 'fastify';
import type {Pool} from 'pg';
import {loadTemplate} from '../templates/registry.js';
import {submitJob} from '../jobs/admission.js';
import {getJob} from '../jobs/repository.js';
import type {Outputs} from '../storage/outputs.js';
import {failure,OperationError} from '../errors.js';
import type {Uploads} from '../uploads/service.js';
import {registerUploads} from './uploads.js';
const status=(code:string)=>({INVALID_JOB_ID:400,INVALID_DATA:422,TYPE_MISMATCH:422,MISSING_REQUIRED:422,EMPTY_CONTENT:422,IMAGE_JOBS_UNAVAILABLE:422,INVALID_UPLOAD:422,INVALID_RESOURCE:422,UPLOAD_NOT_FOUND:404,UPLOAD_GONE:410,UPLOAD_CONFLICT:409,UPLOAD_INCOMPLETE:409,TEMPLATE_NOT_FOUND:404,VERSION_NOT_FOUND:404,JOB_NOT_FOUND:404,OUTPUT_GONE:410}[code]??503);
export function createServer(deps:{pool:Pool;outputs:Outputs;isReady:()=>boolean;bodyLimit?:number;uploads?:Uploads;imagesEnabled?:boolean}){
 const app=Fastify({logger:false,forceCloseConnections:true,bodyLimit:deps.bodyLimit??2097152});
 if(deps.uploads)app.register(async routes=>{
  routes.addHook('onRequest',async(_req,reply)=>{if(!deps.isReady())return reply.code(503).send(failure(new OperationError('UNAVAILABLE','service','Service unavailable')));});
  await registerUploads(routes,deps.uploads!);
 });
 const pending=new Set<Promise<void>>();app.addHook('onClose',async()=>{await Promise.allSettled([...pending]);});
 app.setErrorHandler((error,request,reply)=>{const e=error as {statusCode?:number};const code=e.statusCode===413?413:e.statusCode&&e.statusCode>=400&&e.statusCode<500?400:503;reply.code(code).send(failure(new OperationError(code===413?'BODY_TOO_LARGE':code===400?'INVALID_REQUEST':'UNAVAILABLE','request',code===413?'Request exceeds size limit':code===400?'Invalid request':'Service unavailable')));});
 app.get('/health',async(_req,reply)=>{try{if(!deps.isReady())throw Error();await deps.pool.query('SELECT 1');return {ok:true,value:{ready:true},warnings:[]};}catch{reply.code(503);return failure(new OperationError('UNAVAILABLE','service','Service unavailable'));}});
 app.get<{Params:{docKey:string};Querystring:{version?:string}}>('/templates/:docKey/contract',async(req,reply)=>{
  const raw=req.query.version;let version:number|undefined;
  if(raw!==undefined){if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>2147483647){reply.code(400);return failure(new OperationError('INVALID_VERSION','version','Invalid version'));}version=Number(raw);}
  const r=await loadTemplate(deps.pool,req.params.docKey,version);if(!r.ok){reply.code(status(r.issues[0]!.code));return r;}
  const t=r.value.template.definition;return {ok:true,value:{docKey:t.docKey,version:t.version,globalSchema:t.globalSchema,formats:Object.fromEntries(Object.entries(t.formats).map(([key,f])=>[key,{label:f.label,description:f.description,inputSchema:f.inputSchema}])),examples:t.examples},warnings:[]};
 });
 app.post('/jobs',async(req,reply)=>{
  if(!deps.isReady()){reply.code(503);return failure(new OperationError('UNAVAILABLE','service','Service unavailable'));}
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||typeof (req.body as Record<string,unknown>).docKey!=='string'){reply.code(400);return failure(new OperationError('INVALID_REQUEST','request','Invalid request'));}
  const r=await submitJob(deps.pool,req.body,deps.imagesEnabled===true);reply.code(r.ok?202:status(r.issues[0]!.code));return r;
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
