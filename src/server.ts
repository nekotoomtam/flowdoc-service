import {loadBundledResources} from '@flowdoc/core';
import {resolve,join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {createPool} from './db/connection.js';
import {createPdfFiles,readFilePolicy} from './storage/pdf-files.js';
import {createOutputs} from './storage/outputs.js';
import {startProcessor} from './jobs/processor.js';
import {createServer} from './http/server.js';
import {renderPinnedJob,cleanupRenderTemps} from './jobs/render.js';
function integer(name:string,value:string|undefined,fallback:number,max:number){const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid '+name);return n;}
async function main(){
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
 // Validate every setting before acquiring a pool, coordinator, listener or timer.
 const policy=readFilePolicy(process.env);
 const deadline=integer('render deadline',process.env.EXPORT_RENDER_TIMEOUT_MS,120000,3600000);
 const maxBytes=integer('output limit',process.env.EXPORT_MAX_PDF_BYTES,52428800,1073741824);
 const bodyLimit=integer('body limit',process.env.EXPORT_BODY_LIMIT_BYTES,2097152,67108864);
 const port=integer('port',process.env.PORT,3000,65535),host=process.env.HOST??'127.0.0.1';
 const tempRoot=resolve(process.env.EXPORT_TEMP_DIR??'temp'),renderRoot=join(tempRoot,'flowdoc-job-renders');await mkdir(tempRoot,{recursive:true});
 const resources=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot});if(!resources.ok)throw Error('Runtime unavailable');
 const pool=createPool(process.env.DATABASE_URL);let processor:Awaited<ReturnType<typeof startProcessor>>|undefined,app:ReturnType<typeof createServer>|undefined,timer:NodeJS.Timeout|undefined;
 let closing=false,cleanup:Promise<void>|undefined;
 const stop=async()=>{if(closing)return;closing=true;if(timer)clearInterval(timer);await Promise.allSettled([app?.close(),processor?.stop(),cleanup]);await pool.end();};
 try{
  const files=await createPdfFiles(process.env.EXPORT_OUTPUT_DIR??'output'),outputs=createOutputs(pool,files,policy.tempHours);
  processor=await startProcessor({pool,files,policy,initialize:async()=>{await cleanupRenderTemps(renderRoot);await outputs.cleanup();},render:(p,t,s)=>renderPinnedJob(p,t,s,deadline,maxBytes,renderRoot)});
  app=createServer({pool,outputs,isReady:()=>!closing&&processor!.isReady(),bodyLimit});
  await app.listen({host,port});
  timer=setInterval(()=>{if(cleanup)return;cleanup=outputs.cleanup().catch(()=>{}).finally(()=>{cleanup=undefined;});},60000);
  process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
 }catch(e){await stop();throw e;}
}
main().catch(()=>{console.error('FlowDoc service startup failed');process.exitCode=1;});
