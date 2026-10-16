import {registerFontsAuthoring} from './fonts-authoring.js';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {createAuthoring} from '../authoring/service.js';
import {getJob,validJobId} from '../jobs/repository.js';
import {failure,OperationError} from '../errors.js';
import type {Outputs} from '../storage/outputs.js';
import type {Uploads} from '../uploads/service.js';
import {registerUploads} from './uploads.js';
const exampleDefinition=JSON.parse(readFileSync(new URL('../../examples/area-document-template.json',import.meta.url),'utf8'));
const exampleRequest=JSON.parse(readFileSync(new URL('../../examples/area-document-request.json',import.meta.url),'utf8'));
export interface AuthoringAccess {token:string;principal:string}
export function checkAuthoringAccess(access:AuthoringAccess){if(typeof access.token!=='string'||access.token.length<32||typeof access.principal!=='string'||!access.principal.trim()||access.principal.length>200)throw Error('Invalid authoring access configuration');}
export async function registerAuthoring(app:FastifyInstance,deps:{pool:Pool;outputs:Outputs;isReady:()=>boolean;maxOutstanding:number;imagesEnabled:boolean;access:AuthoringAccess;uploads?:Uploads}){
 const api=createAuthoring(deps.pool,deps.access.principal,deps),expected=Buffer.from('Bearer '+deps.access.token);
 app.addHook('onRequest',async(req,reply)=>{
  const supplied=Buffer.from(req.headers.authorization??'');
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply.code(401).send(failure(new OperationError('UNAUTHORIZED','authoring','Authoring credential required')));
  if(!deps.isReady())return reply.code(503).send(failure(new OperationError('UNAVAILABLE','service','Service unavailable')));
 });
 if(deps.uploads){const uploads=deps.uploads;
  const owner=async(id:string)=>{if(!validJobId(id)||(await deps.pool.query('SELECT 1 FROM upload_sessions WHERE id=$1 AND authoring_principal=$2',[id,deps.access.principal])).rowCount!==1)throw new OperationError('UPLOAD_NOT_FOUND','uploadId','Upload not found');};
  await app.register(async routes=>registerUploads(routes,{...uploads,
   async create(input){return uploads.create(input,deps.access.principal);},
   async get(id){await owner(id);return uploads.get(id);},async finalize(id){await owner(id);return uploads.finalize(id);},async receive(id,item,input,signal){await owner(id);return uploads.receive(id,item,input,signal);}
  }),{prefix:'/authoring'});
 }
 registerFontsAuthoring(app,deps.pool);
 const send=(reply:any,r:any,success=200)=>{const code=r.ok?success:({NOT_FOUND:404,UNAVAILABLE:503,FONT_HEIGHT_PROPOSAL_EXPIRED:409,FONT_HEIGHT_PROFILE_CHANGED:409,TEMPLATE_NOT_FOUND:404,JOB_NOT_FOUND:404,STALE_CURRENT:409,IDEMPOTENCY_CONFLICT:409,TEMPLATE_IDENTITY_CONFLICT:409,OWNERSHIP_CONFLICT:409,QUEUE_FULL:503,STORAGE_FAILED:503,UPLOAD_NOT_FOUND:404,UPLOAD_GONE:410,UPLOAD_CONFLICT:409,UPLOAD_INCOMPLETE:409}[r.issues?.[0]?.code as string]??422);return reply.code(code).send(r);};
 app.get('/authoring/contract',async()=>({ok:true,value:{nodeModelVersions:[18,19],sectionInstances:{model:19,input:'array-by-id',assembly:'saved-definition',stage:1,coverArea:false,scopedToc:false},schemaVersions:[1,2],fonts:{catalog:'/authoring/fonts',readiness:'/authoring/drafts/:id/font-readiness',selection:'exact-release-weight-style',syntheticFaces:false,automaticFallback:false,adminSeparate:true,heightAdjustment:{methodId:'thai-bo-baseline-top-v1',optIn:true,proposalTtlSeconds:900,precisionDecimals:6,layoutCheck:'not_checked'}},flow:['create-identity','save-definition','validate','preview'],draftDefinitionVersion:1,publicationEnabled:false,bodyLimitBytes:app.initialConfig.bodyLimit,maxOutstanding:deps.maxOutstanding,areaValue:'ordered array of {format,data}',examples:{definition:exampleDefinition,sampleRequest:exampleRequest,instruction:'Replace definition.templateId/docKey and sampleRequest.docKey with the identity returned by create. Definition.version stays 1; revision is separate.'},validation:'Core validateTemplate is authoritative; examples are not an exhaustive JSON schema. validate(sampleRequest) composes but does not prove pagination; preview performs layout.',retry:'Successful authoring receipts retained until administrative database cleanup; reuse key only for identical request. Preview retry returns original job even after PDF expiry; use a new key for a fresh preview.',uploadLimits:deps.uploads?.config??null,variableSchemas:['globalSchema','sections[].inputSchema','sections[].header.inputSchema','sections[].footer.inputSchema','areaFormats[].inputSchema'],emptyDraft:{revision:0,definition:null,preview:false},preview:{published:false,pinnedRevision:true,downloads:'repeatable until output TTL',images:deps.imagesEnabled},errors:['INVALID_TEMPLATE','MISSING_REQUIRED','UNKNOWN_FORMAT','STALE_CURRENT','DRAFT_EMPTY','IDEMPOTENCY_CONFLICT'],identityRules:'Server creates templateId. Save definition under that ID with the same docKey and version=1. Internal IDs are server owned.'},warnings:[]}));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/font-height-adjustments',async(req,reply)=>send(reply,await api.proposeFontHeight(req.params.id,req.body)));
 app.post<{Params:{id:string;proposalId:string}}>('/authoring/drafts/:id/font-height-adjustments/:proposalId/confirm',async(req,reply)=>send(reply,await api.confirmFontHeight(req.params.id,req.params.proposalId,req.body)));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/font-readiness',async(req,reply)=>send(reply,await api.fontReadiness(req.params.id,req.body)));
 app.post('/authoring/validate',async(req,reply)=>send(reply,await api.validate(req.body)));
 app.post('/authoring/drafts',async(req,reply)=>send(reply,await api.create(req.body),201));
 app.get<{Params:{id:string}}>('/authoring/drafts/:id',async(req,reply)=>send(reply,await api.get(req.params.id)));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/sections/import',async(req,reply)=>send(reply,await api.importSections(req.params.id,req.body)));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/sections',async(req,reply)=>send(reply,await api.createSection(req.params.id,req.body),201));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/clone',async(req,reply)=>send(reply,await api.cloneDraft(req.params.id,req.body),201));
 app.put<{Params:{id:string}}>('/authoring/drafts/:id',async(req,reply)=>send(reply,await api.save(req.params.id,req.body)));
 app.post<{Params:{id:string}}>('/authoring/drafts/:id/previews',async(req,reply)=>send(reply,await api.preview(req.params.id,req.body),202));
 const ownedJob=async(id:string)=>{const pin=await api.previewOwner(id);if(!pin)throw new OperationError('JOB_NOT_FOUND','jobId','Preview not found');return pin;};
 app.get<{Params:{id:string}}>('/authoring/previews/:id',async(req,reply)=>{
  try{const pin=await ownedJob(req.params.id),r=await getJob(deps.pool,req.params.id,true);if(!r.ok)return send(reply,r);
   const {version,...job}=r.value,available=job.status==='succeeded'&&await deps.outputs.available(job.jobId);
   return {ok:true,value:{...job,revision:pin.preview_revision,fingerprint:pin.preview_fingerprint,templateId:pin.preview_template_id,outputAvailable:available,...(job.status==='succeeded'&&!available?{outputState:'expired'}:{}),...(available?{artifactHandle:job.jobId}: {})},warnings:r.warnings};
  }catch(e){return send(reply,failure(e));}
 });
 const pending=new Set<Promise<void>>();app.addHook('onClose',async()=>{await Promise.allSettled([...pending]);});
 app.get<{Params:{id:string}}>('/authoring/previews/:id/pdf',async(req,reply)=>{
  try{await ownedJob(req.params.id);const r=await getJob(deps.pool,req.params.id,true);if(!r.ok)return send(reply,r);if(r.value.status!=='succeeded')return reply.code(409).send(failure(new OperationError('OUTPUT_NOT_READY','job','Preview is not ready')));
   const lease=await deps.outputs.acquire(req.params.id);let ended=false,settled=false;let complete!:()=>void;
   const done=new Promise<void>(resolve=>{complete=resolve;});pending.add(done);lease.stream.once('end',()=>{ended=true;});
   const finish=(success:boolean)=>{if(settled)return;settled=true;void lease.finish(success).catch(()=>{}).finally(()=>{pending.delete(done);complete();});};
   reply.raw.once('finish',()=>finish(ended&&reply.raw.statusCode===200));reply.raw.once('close',()=>{if(!reply.raw.writableFinished){lease.stream.destroy();finish(false);}});
   return reply.type('application/pdf').header('Cache-Control','no-store').header('Content-Disposition',`attachment; filename="preview-${req.params.id}.pdf"`).send(lease.stream);
  }catch(e){if(e instanceof OperationError&&e.code==='OUTPUT_GONE')return reply.code(410).send(failure(e));return send(reply,failure(e));}
 });
}
