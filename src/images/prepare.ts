import type {WorkerLauncher,BlockedWorker} from '../workers/contracts.js';
import {workerError} from '../workers/contracts.js';
import {fork} from 'node:child_process';
import {mkdir,rename,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {ImagePreparationInput,ImagePreparationResult} from './types.js';

// Resource ownership and the serial job processor keep this internal API off HTTP.
export type ImagePreparer=(input:ImagePreparationInput)=>Promise<ImagePreparationResult>;
export function createImagePreparer(launcher?:WorkerLauncher):ImagePreparer{
 let active=false,poisoned=false;
 return async input=>{
  if(poisoned)throw workerError('WORKER_STOP_UNCONFIRMED');
  if(!launcher&&process.env.FLOWDOC_WORKER_ISOLATION==='required')throw workerError('WORKER_IMAGE_PREPARER_REQUIRED');
  if(active)throw Error('Image preparation busy');active=true;
  try{return await prepareOne(input,launcher);}catch(e){if((e as any)?.code==='WORKER_STOP_UNCONFIRMED')poisoned=true;throw e;}finally{active=false;}
 };
}
export const prepareImage=createImagePreparer();
async function prepareOne(input:ImagePreparationInput,launcher?:WorkerLauncher):Promise<ImagePreparationResult>{
 const dpi=input.dpi??200,timeout=input.timeoutMs??30000;
 if(![input.widthPt,input.heightPt,dpi,timeout].every(n=>Number.isFinite(n)&&n>0)||dpi>600||timeout>30000)throw Error('Invalid image preparation bounds');
 const width=Math.ceil(input.widthPt*dpi/72),height=Math.ceil(input.heightPt*dpi/72);
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width*height>8_000_000)throw Error('Image target exceeds pixel budget');
 if(input.signal?.aborted)throw Error('Image preparation cancelled');
 const root=resolve(input.outputDirectory);await mkdir(root,{recursive:true});
 const id=randomUUID(),temporary=join(root,id+'.part');
 let published=false,safeToRemove=true;let handle:BlockedWorker|undefined;
 // Serialize the transport before waiting on launcher admission.
 const message=JSON.stringify({source:resolve(input.sourcePath),output:temporary,width,height,widthPt:input.widthPt,heightPt:input.heightPt});
 if(launcher)try{handle=await launcher.spawnBlocked({kind:'image-prepare',deadlineAt:Date.now()+timeout,...(input.signal?{signal:input.signal}:{})});}catch(e){if((e as any)?.code==='WORKER_STOP_UNCONFIRMED')safeToRemove=false;throw e;}
 try{
  const response=await new Promise<{result:any;timedOut:boolean;cancelled:boolean}>((done,reject)=>{
   const child=handle?.child??fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
   let result:unknown,timedOut=false,cancelled=false;
   const kill=()=>{if(handle)void handle.stop('image limit/abort').then(()=>finish(),()=>{safeToRemove=false;clearTimeout(timer);input.signal?.removeEventListener('abort',abort);reject(workerError('WORKER_STOP_UNCONFIRMED'));});else child.kill('SIGKILL');};
   const abort=()=>{cancelled=true;kill();};
   const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
   input.signal?.addEventListener('abort',abort,{once:true});
   child.on('message',m=>{result=m;});
   child.once('error',()=>{kill();});
   let finished=false;const finish=async()=>{if(finished)return;finished=true;clearTimeout(timer);input.signal?.removeEventListener('abort',abort);try{if(handle)await handle.waitStopped();done({result,timedOut,cancelled});}catch{safeToRemove=false;reject(workerError('WORKER_STOP_UNCONFIRMED'));}};
   child.once('close',()=>void finish());
   if(input.signal?.aborted)abort();
   else {const send=()=>{if(!cancelled&&!timedOut)child.send!(JSON.parse(message),error=>{if(error)kill();});};
    if(handle)void(async()=>{try{await handle.bind();await handle.start();send();}catch{try{await handle!.stop('image start failure');await finish();}catch{safeToRemove=false;clearTimeout(timer);input.signal?.removeEventListener('abort',abort);reject(workerError('WORKER_STOP_UNCONFIRMED'));}}})();else send();}
  });
  if(response.cancelled||input.signal?.aborted)throw Error('Image preparation cancelled');
  if(response.timedOut)return {status:'skipped',warnings:[{code:'IMAGE_TIMEOUT',message:'Image preparation exceeded its time limit'}]};
  const r=response.result;
  if(!r?.ok)return {status:'skipped',warnings:[{code:'IMAGE_UNUSABLE',message:'Image could not be prepared within supported format and size limits'}]};
  const path=join(root,id+(r.mediaType==='image/jpeg'?'.jpg':'.png'));await rename(temporary,path);published=true;
  return {status:'prepared',image:{path,width:r.width,height:r.height,mediaType:r.mediaType,byteSize:r.byteSize,effectiveDpi:r.effectiveDpi},warnings:r.effectiveDpi<dpi?[{code:'IMAGE_LOW_RESOLUTION',message:'Source image has insufficient pixels for the requested frame density'}]:[]};
 }finally{
  if(!published&&safeToRemove)try{await unlink(temporary);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
}
