import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {OperationError} from '../errors.js';
import {FONT_LIMITS,type FontMetadata} from './types.js';
import {workerError,type WorkerLauncher,type BlockedWorker} from '../workers/contracts.js';
const execute=promisify(execFile);
export interface InspectionOptions {pythonExecutable?:string;timeoutMs?:number;includeHeightMetric?:boolean}
export type FontInspector=((path:string,options?:InspectionOptions)=>Promise<FontMetadata>)&{isReady():boolean;stop():Promise<void>};
const unavailable=()=>new OperationError('FONT_INSPECTION_UNAVAILABLE','font','Static TTF inspection unavailable');
/** One composition-owned serial parser; uncertain termination poisons its queue. */
export function createFontInspector(launcher?:WorkerLauncher):FontInspector{
 let queue:Promise<void>=Promise.resolve(),poisoned=false,closing=false,active:AbortController|undefined;
 const inspect=async(path:string,options:InspectionOptions={}):Promise<FontMetadata>=>{
  if(closing)throw new OperationError('UNAVAILABLE','font','Font inspection interrupted');
  if(poisoned||(!launcher&&process.env.FLOWDOC_WORKER_ISOLATION==='required'))throw unavailable();
  const previous=queue;let release!:()=>void;queue=new Promise<void>(r=>release=r);await previous;
  let handle:BlockedWorker|undefined,timer:NodeJS.Timeout|undefined,timedOut=false;
  try{
   if(closing||poisoned)throw unavailable();
   const abort=new AbortController();active=abort;let stdout:string;
   if(launcher){
    const timeout=options.timeoutMs??FONT_LIMITS.parseMs;
    if(!Number.isFinite(timeout)||timeout<1||timeout>FONT_LIMITS.parseMs)throw Error('bounds');
    let finish!:()=>void,failure:unknown,closed=false,code:number|null=null,overflow=false;const exit=new Promise<void>(r=>finish=r),chunks:Buffer[]=[];let bytes=0,errors=0;
    const stop=()=>{if(handle)void handle.stop('font inspection limit').catch(e=>{failure=e;finish();});};
    timer=setTimeout(()=>{timedOut=true;abort.abort();stop();},timeout);
    handle=await launcher.spawnBlocked({kind:'font-inspect',deadlineAt:Date.now()+timeout,signal:abort.signal,fontPath:resolve(path),...(options.includeHeightMetric!==undefined?{includeHeightMetric:options.includeHeightMetric}:{})});
    handle.child.stdout!.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>2*FONT_LIMITS.metadataBytes){overflow=true;stop();}else chunks.push(b);});
    // The fixed launcher discards stderr; bound it only when a trusted seam pipes it.
    handle.child.stderr?.on('data',(b:Buffer)=>{errors+=b.length;if(errors>2*FONT_LIMITS.metadataBytes){overflow=true;stop();}});
    handle.child.once('error',e=>{failure=e;finish();});handle.child.once('close',c=>{closed=true;code=c;finish();});
    await handle.bind();await handle.start();await exit;if(failure)throw failure;
    await handle.waitStopped();if(timedOut)throw Object.assign(Error(),{killed:true});if(overflow||!closed||code!==0)throw Error('inspection');stdout=Buffer.concat(chunks).toString('utf8');
   }else{
    const result=await execute(options.pythonExecutable??process.env.PYTHON_EXECUTABLE??'python',[fileURLToPath(new URL('../../runtime/python/inspectFont.py',import.meta.url)),path,...(options.includeHeightMetric?['--height-metric']:[])],{encoding:'utf8',timeout:options.timeoutMs??FONT_LIMITS.parseMs,maxBuffer:2*FONT_LIMITS.metadataBytes,windowsHide:true,signal:abort.signal});stdout=result.stdout;
   }
   const value=JSON.parse(stdout)as FontMetadata;
   if(!Number.isInteger(value.rawWeight)||value.rawWeight<1||value.rawWeight>1000||!['normal','italic'].includes(value.style)||!Array.isArray(value.coverage)||!value.names?.family)throw Error('metadata');
   return value;
  }catch(error){
   const e=error as NodeJS.ErrnoException&{killed?:boolean};
   if(e.code==='WORKER_STOP_UNCONFIRMED'){poisoned=true;throw error;}
   if(closing)throw new OperationError('UNAVAILABLE','font','Font inspection interrupted');
   if(error instanceof OperationError)throw error;
   throw new OperationError(e.code==='ENOENT'||/^WORKER_(BROKER|CONFIGURATION)/.test(e.code??'')?'FONT_INSPECTION_UNAVAILABLE':timedOut||e.killed?'FONT_INSPECTION_TIMEOUT':'INVALID_FONT_FILE','font','Static TTF inspection did not succeed');
  }finally{
   clearTimeout(timer);active=undefined;
   try{if(handle)await handle.stop('font inspection cleanup');}catch{poisoned=true;throw workerError('WORKER_STOP_UNCONFIRMED');}finally{release();}
   if(closing&&!poisoned)throw new OperationError('UNAVAILABLE','font','Font inspection interrupted');
  }
 };
 return Object.assign(inspect,{isReady:()=>!closing&&!poisoned&&(!launcher||launcher.isReady()),async stop(){closing=true;active?.abort();await queue;if(poisoned)throw workerError('WORKER_STOP_UNCONFIRMED');}});
}
export const inspectFont=createFontInspector();
