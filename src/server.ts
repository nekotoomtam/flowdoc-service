import {fileURLToPath} from 'node:url';
import {readWorkerConfig} from './workers/config.js';
import {createWorkerLauncher} from './workers/launcher.js';
import type {WorkerLauncher} from './workers/contracts.js';
import {createFontInspector,type FontInspector} from './fonts/inspection.js';
import {createFontPreflightGate,type FontPreflightGate} from './fonts/preflight-gate.js';
import {fontProbeDocument} from './fonts/probe.js';
import {createImagePreparer} from './images/prepare.js';
import {transaction} from './db/connection.js';
import {checkFontAdminAccess} from './http/fonts-admin.js';
import {loadBundledResources} from '@flowdoc/core';
import * as coreRuntime from '@flowdoc/core';
import {OperationError} from './errors.js';
import {resolve,join} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {taskCredentials} from './tasks/config.js';
import {createTaskOwnership,type TaskOwnership} from './tasks/ownership.js';
import {createTaskIntake} from './tasks/intake.js';
import {readTaskQueueConfig,queueAdmissionLimit} from './tasks/queue-profile.js';
import {createTaskProcessing} from './tasks/processing.js';
import {createPool} from './db/connection.js';
import {assertRuntimeSchema} from './db/runtime-schema.js';
import {createPdfFiles,readFilePolicy} from './storage/pdf-files.js';
import {createOutputs} from './storage/outputs.js';
import {readJobConfig} from './jobs/config.js';
import {startProcessor} from './jobs/processor.js';
import {createServer} from './http/server.js';
import {createJobRenderer,cleanupRenderTemps} from './jobs/render.js';
import {readUploadConfig} from './uploads/config.js';
import {createUploads} from './uploads/service.js';
import {createResourceFiles} from './storage/resource-files.js';
import {checkAuthoringAccess} from './http/authoring.js';
function integer(name:string,value:string|undefined,fallback:number,max:number){const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid '+name);return n;}
export async function startService(){
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
 if(coreRuntime.DOCX_IMAGE_OMISSIONS_CONTRACT!=='docx-image-omissions/1')throw new OperationError('RENDERER_PIN_MISMATCH','runtime.core','Pinned Core image omission capability unavailable');
 // Validate every setting before acquiring a pool, coordinator, listener or timer.
 const workerConfig=readWorkerConfig(process.env);
 const jobConfig=readJobConfig(process.env);
 const queueConfig=readTaskQueueConfig(process.env),maxOutstanding=queueAdmissionLimit(jobConfig.maxOutstanding,queueConfig);
 let resolver:ReturnType<typeof taskCredentials>;if(process.env.TASK_CREDENTIALS_FILE){const bytes=await readFile(process.env.TASK_CREDENTIALS_FILE);if(bytes.length>65536)throw Error('Invalid task credentials');resolver=taskCredentials(JSON.parse(bytes.toString('utf8')));if(process.platform!=='linux')throw Error('Task runtime unavailable');}
 if(queueConfig.profile.strict&&!resolver)throw Error('Explicit queue profile requires task credentials');
 const authoring=process.env.AUTHORING_TOKEN?{token:process.env.AUTHORING_TOKEN,principal:process.env.AUTHORING_PRINCIPAL??'local-owner'}:undefined;
 if(authoring)checkAuthoringAccess(authoring);
 if(!!process.env.FONT_ADMIN_TOKEN!==!!process.env.FONT_ADMIN_PRINCIPAL)throw Error('Incomplete font administrator configuration');
 const fontAdmin=process.env.FONT_ADMIN_TOKEN?{token:process.env.FONT_ADMIN_TOKEN,principal:process.env.FONT_ADMIN_PRINCIPAL!}:undefined;
 if(fontAdmin)checkFontAdminAccess(fontAdmin,authoring?.token);
 const policy=readFilePolicy(process.env);
 const uploadConfig=readUploadConfig(process.env);
 const deadline=integer('render deadline',process.env.EXPORT_RENDER_TIMEOUT_MS,120000,3600000);
 const maxBytes=integer('output limit',process.env.EXPORT_MAX_PDF_BYTES,52428800,1073741824);
 const bodyLimit=integer('body limit',process.env.EXPORT_BODY_LIMIT_BYTES,2097152,67108864);
 const port=integer('port',process.env.PORT,3000,65535),host=process.env.HOST??'127.0.0.1';
 const tempRoot=resolve(process.env.EXPORT_TEMP_DIR??'temp'),renderRoot=join(tempRoot,'flowdoc-job-renders');
 let launcher:WorkerLauncher|undefined,inspector:FontInspector|undefined,fontGate:FontPreflightGate|undefined;
 let pool:ReturnType<typeof createPool>|undefined,uploads:ReturnType<typeof createUploads>|undefined;
 let processor:Awaited<ReturnType<typeof startProcessor>>|undefined,app:ReturnType<typeof createServer>|undefined,timer:NodeJS.Timeout|undefined;
 let taskIntake:Awaited<ReturnType<typeof createTaskIntake>>|undefined,taskProcessing:Awaited<ReturnType<typeof createTaskProcessing>>|undefined,ownership:TaskOwnership|undefined;
 let closing=false,cleanup:Promise<void>|undefined,stopping:Promise<void>|undefined;
 const runtimeReady=()=>!closing&&(!launcher||launcher.isReady())&&(!inspector||inspector.isReady())&&(!fontGate||fontGate.isReady());
 const terminate=()=>{void stop().catch(()=>{process.exitCode=1;});};
 const stop=()=>stopping??=(async()=>{
  closing=true;launcher?.closeAdmissions();if(timer)clearInterval(timer);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);
  const pending=await Promise.allSettled([uploads?.stop(),taskProcessing?.stop(),taskIntake?.stop(),app?.close(),fontGate?.stop(),inspector?.stop(),cleanup]);
  const processorStop=await Promise.allSettled([processor?.stop()]);const scoped=await Promise.allSettled([launcher?.drain()]);
  const errors=[...pending,...processorStop,...scoped].filter((x):x is PromiseRejectedResult=>x.status==='rejected').map(x=>x.reason);
  if(errors.length)throw errors.find(e=>e?.code==='WORKER_STOP_UNCONFIRMED')??errors[0];
  await ownership?.close();await pool?.end();
 })();
 try{
  // Authenticate required isolation before acquiring runtime, DB or listener state.
  if(workerConfig.mode==='required')launcher=await createWorkerLauncher(workerConfig);
  pool=createPool(process.env.DATABASE_URL);await assertRuntimeSchema(pool);
  inspector=createFontInspector(launcher);const renderer=createJobRenderer(launcher),preflightRenderer=createJobRenderer(launcher,'font-preflight'),prepare=createImagePreparer(launcher);
  await mkdir(tempRoot,{recursive:true});
  if(!launcher){const resources=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot});if(!resources.ok)throw Error('Runtime unavailable');}
  const resourceFiles=await createResourceFiles(process.env.UPLOAD_STAGING_DIR??'staging');uploads=createUploads({pool,files:resourceFiles,config:uploadConfig});
  const files=await createPdfFiles(process.env.EXPORT_OUTPUT_DIR??'output'),outputs=createOutputs(pool,files,policy.tempHours);
  if(resolver){const root=process.env.TASK_STORAGE_DIR??join(tempRoot,'flowdoc-tasks');ownership=await createTaskOwnership(root);ownership.signal.addEventListener('abort',()=>{if(!closing)terminate();},{once:true});taskIntake=await createTaskIntake({pool,root,ownership,...(launcher?{workerLauncher:launcher}:{}),deferRecovery:true,resolveCredential:resolver,policy:{maxOutstanding:queueConfig.maxOutstanding},queueResources:{profile:queueConfig.profile}});taskProcessing=await createTaskProcessing({pool,intake:taskIntake,workerReady:()=>runtimeReady()&&(processor?.isReady()??false)});}
  fontGate=createFontPreflightGate(taskIntake?.processingContext.resources,preflightRenderer.renderDocumentJob);
  if(launcher){
   const probe=fontProbeDocument({schemaVersion:1,nodeModelVersion:20,template:{templateId:'startup',docKey:'startup',version:1},styles:{body:{fontFamilyKey:'sarabun',fontWeight:'normal',fontSize:{value:12,unit:'pt'},lineHeightPt:20}},nodes:{p:{id:'p',type:'text-block',props:{textStyleId:'body'},children:[{id:'t',type:'text',text:'FlowDoc ready ไทย'}]}}} as any);
   const checked=await transaction(pool,c=>fontGate!.run(c,undefined,signal=>preflightRenderer.renderDocumentJob({document:probe,images:{}},signal)));if(!checked.ok)throw Error('Runtime unavailable');
  }
  processor=await startProcessor({pool,...(taskProcessing?{tasks:taskProcessing}:{}),files,policy,resources:{files:resourceFiles,config:uploadConfig,prepare},initialize:async leader=>{await taskIntake?.recover(leader);if(ownership&&!ownership.isReady())throw Error('Task owner unavailable');await cleanupRenderTemps(renderRoot);await outputs.cleanup();await uploads!.recover();},render:(p,t,s,images)=>renderer.renderPinnedJob(p,t,s,deadline,maxBytes,renderRoot,images)});
  app=createServer({pool,outputs,uploads,...(launcher?{workerLauncher:launcher}:{}),fontInspector:inspector,preflight:fontGate,isReady:()=>runtimeReady()&&processor!.isReady()&&(!taskIntake||taskIntake.isReady()),bodyLimit,imagesEnabled:true,maxOutstanding,...(taskIntake&&taskProcessing?{tasks:{intake:taskIntake,processing:taskProcessing}}:{}),...(authoring?{authoring}:{}),...(fontAdmin?{fontAdmin}:{})});
  await app.listen({host,port});
  timer=setInterval(()=>{if(cleanup)return;cleanup=Promise.all([outputs.cleanup(),uploads!.cleanup()]).then(()=>{}).catch(()=>{}).finally(()=>{cleanup=undefined;});},60000);
  process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  return {stop,isReady:runtimeReady,app};
 }catch(e){await stop();throw e;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startService().catch(()=>{console.error('FlowDoc service startup failed');process.exitCode=1;});
