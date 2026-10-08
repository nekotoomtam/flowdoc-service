import {fork} from 'node:child_process';
import {mkdir,rename,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {ImagePreparationInput,ImagePreparationResult} from './types.js';

// Resource ownership and the serial job processor keep this internal API off HTTP.
let active=false;
export async function prepareImage(input:ImagePreparationInput):Promise<ImagePreparationResult>{
 if(active)throw Error('Image preparation busy');
 active=true;
 try{return await prepareOne(input);}finally{active=false;}
}
async function prepareOne(input:ImagePreparationInput):Promise<ImagePreparationResult>{
 const dpi=input.dpi??200,timeout=input.timeoutMs??30000;
 if(![input.widthPt,input.heightPt,dpi,timeout].every(n=>Number.isFinite(n)&&n>0)||dpi>600||timeout>30000)throw Error('Invalid image preparation bounds');
 const width=Math.ceil(input.widthPt*dpi/72),height=Math.ceil(input.heightPt*dpi/72);
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width*height>8_000_000)throw Error('Image target exceeds pixel budget');
 if(input.signal?.aborted)throw Error('Image preparation cancelled');
 const root=resolve(input.outputDirectory);await mkdir(root,{recursive:true});
 const id=randomUUID(),temporary=join(root,id+'.part');
 let published=false;
 try{
  const response=await new Promise<{result:any;timedOut:boolean;cancelled:boolean}>((done,reject)=>{
   const child=fork(fileURLToPath(new URL('./worker.js',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
   let result:unknown,timedOut=false,cancelled=false;
   const abort=()=>{cancelled=true;child.kill('SIGKILL');};
   const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
   input.signal?.addEventListener('abort',abort,{once:true});
   child.on('message',m=>{result=m;});
   child.once('error',()=>{child.kill('SIGKILL');});
   child.once('close',()=>{clearTimeout(timer);input.signal?.removeEventListener('abort',abort);done({result,timedOut,cancelled});});
   if(input.signal?.aborted)abort();
   else child.send({source:resolve(input.sourcePath),output:temporary,width,height,widthPt:input.widthPt,heightPt:input.heightPt},error=>{if(error)child.kill('SIGKILL');});
  });
  if(response.cancelled)throw Error('Image preparation cancelled');
  if(response.timedOut)return {status:'skipped',warnings:[{code:'IMAGE_TIMEOUT',message:'Image preparation exceeded its time limit'}]};
  const r=response.result;
  if(!r?.ok)return {status:'skipped',warnings:[{code:'IMAGE_UNUSABLE',message:'Image could not be prepared within supported format and size limits'}]};
  const path=join(root,id+(r.mediaType==='image/jpeg'?'.jpg':'.png'));await rename(temporary,path);published=true;
  return {status:'prepared',image:{path,width:r.width,height:r.height,mediaType:r.mediaType,byteSize:r.byteSize,effectiveDpi:r.effectiveDpi},warnings:r.effectiveDpi<dpi?[{code:'IMAGE_LOW_RESOLUTION',message:'Source image has insufficient pixels for the requested frame density'}]:[]};
 }finally{
  if(!published)try{await unlink(temporary);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 }
}
