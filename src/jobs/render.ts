import type {WorkerLauncher,BlockedWorker,WorkerKind} from '../workers/contracts.js';
import {workerError} from '../workers/contracts.js';
import type {FontSnapshot} from '../fonts/snapshot.js';
import {fontIssue} from '../fonts/readiness.js';
import {mkdir,mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join,resolve as resolvePath} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {PreparedInput,TemplateDefinition,Result,PdfArtifact,Issue} from '@flowdoc/core';
import type {JobImageInput} from '../images/job.js';
export type DocumentJobRenderer=(imageInput:JobImageInput,signal?:AbortSignal,fontSnapshot?:FontSnapshot,fontStorageRoot?:string)=>Promise<Result<Pick<PdfArtifact,'bytes'|'mediaType'>>>;
export function createJobRenderer(launcher?:WorkerLauncher,kind:Extract<WorkerKind,'legacy-render'|'font-preflight'>='legacy-render'){
 const check=()=>{if(!launcher&&process.env.FLOWDOC_WORKER_ISOLATION==='required')throw workerError('WORKER_RENDERER_REQUIRED');};
 return {
  renderPinnedJob(prepared:PreparedInput,template:TemplateDefinition,signal?:AbortSignal,deadlineMs=120000,maxBytes=52428800,tempRoot=join(tmpdir(),'flowdoc-job-renders'),imageInput?:JobImageInput,fontSnapshot?:FontSnapshot,fontStorageRoot?:string):Promise<Result<Pick<PdfArtifact,'bytes'|'mediaType'>>>{
   try{check();return renderSerializedJob({text:JSON.stringify(imageInput?{mode:'document',imageInput,fontSnapshot,fontStorageRoot}:{mode:'compose',template,prepared,fontSnapshot,fontStorageRoot})},signal,deadlineMs,maxBytes,tempRoot,launcher,kind);}catch(e){return Promise.reject(e);}
  },
  renderDocumentJob(imageInput:JobImageInput,signal?:AbortSignal,fontSnapshot?:FontSnapshot,fontStorageRoot?:string):Promise<Result<Pick<PdfArtifact,'bytes'|'mediaType'>>>{
   try{check();return renderSerializedJob({text:JSON.stringify({mode:'document',imageInput,fontSnapshot,fontStorageRoot})},signal,120000,52428800,join(tmpdir(),'flowdoc-job-renders'),launcher,kind);}catch(e){return Promise.reject(e);}
  }
 };
}
// Serialize synchronously before suspension; retain only the JSON holder.
export const {renderPinnedJob,renderDocumentJob}=createJobRenderer();
// Suspended async frames can retain the original argument even after reassignment.
// Mutate a holder instead so that retained argument cannot keep the JSON alive.
async function renderSerializedJob(payload:{text:string},signal?:AbortSignal,deadlineMs=120000,maxBytes=52428800,tempRoot=join(tmpdir(),'flowdoc-job-renders'),launcher?:WorkerLauncher,kind:Extract<WorkerKind,'legacy-render'|'font-preflight'>='legacy-render'):Promise<Result<Pick<PdfArtifact,"bytes"|"mediaType">>>{
 const root=resolvePath(tempRoot);await mkdir(root,{recursive:true});const temporary=await mkdtemp(join(root,'render-'));
 let safeToRemove=true;let handle:BlockedWorker|undefined;
 if(launcher)try{handle=await launcher.spawnBlocked({kind,deadlineAt:Date.now()+deadlineMs,...(signal?{signal}:{}),env:{FLOWDOC_RENDER_TEMP:temporary,...(process.env.PYTHON_EXECUTABLE?{PYTHON_EXECUTABLE:process.env.PYTHON_EXECUTABLE}:{})}});}catch(e){if((e as any)?.code==='WORKER_STOP_UNCONFIRMED')safeToRemove=false;if(safeToRemove)await rm(temporary,{recursive:true,force:true});throw e;}
 try{return await new Promise<Result<Pick<PdfArtifact,'bytes'|'mediaType'>>>((resolve,reject)=>{
  const child=handle?.child??spawn(process.execPath,[fileURLToPath(new URL('./render-child.js',import.meta.url))],{stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32',env:{FLOWDOC_RENDER_TEMP:temporary,PATH:process.env.PATH,...(process.env.PYTHON_EXECUTABLE?{PYTHON_EXECUTABLE:process.env.PYTHON_EXECUTABLE}:{})}});
  if(handle||child.pid)safeToRemove=false;
  const chunks:Buffer[]=[];let size=0,failed=false,done=false;
  const uncertain=()=>{done=true;payload.text='';clearTimeout(timer);signal?.removeEventListener('abort',kill);reject(workerError('WORKER_STOP_UNCONFIRMED'));};
  const kill=()=>{failed=true;if(handle){void handle.stop('render limit/abort').then(()=>finish(1),uncertain);return;}try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const timer=setTimeout(kill,deadlineMs);signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  child.stdout!.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes)kill();else chunks.push(chunk);});
  const finish=async(code:number|null)=>{
   if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',kill);
   try{
    // A direct child can close while a native descendant still owns scratch.
    // Keep the promise (and its shared worker credit) until the whole group,
    // including adopted zombies, has disappeared from this Linux namespace.
    if(handle)await handle.waitStopped();
    else if(child.pid&&process.platform==='linux'){
     if(!await legacyGroupGone(child.pid)){kill();const end=Date.now()+5000;while(!await legacyGroupGone(child.pid)){if(Date.now()>=end)throw Error('unconfirmed');await new Promise(r=>setTimeout(r,20));}}
    }
    safeToRemove=true;
   }catch{reject(Object.assign(Error('Worker group termination unconfirmed'),{code:'WORKER_STOP_UNCONFIRMED'}));return;}
   if(signal?.aborted)failed=true;
   const bytes=Buffer.concat(chunks);let warnings=[];
   try{warnings=JSON.parse(await readFile(join(temporary,'warnings.json'),'utf8'));}catch{}
   if(code===0&&!failed&&bytes.subarray(0,5).toString()==='%PDF-'){resolve({ok:true,value:{bytes,mediaType:'application/pdf'},warnings});return;}
   const issues:Issue[]=[];
   // Preserve bounded Core layout diagnostics only after normal child failure.
   // Timeouts, aborts, transport/runtime failures never masquerade as layout errors.
   if(code===1&&!failed)try{
    const raw=await readFile(join(temporary,'issues.json'),'utf8');
    if(raw.length<=65536){const parsed:unknown=JSON.parse(raw);
     if(Array.isArray(parsed))for(const value of parsed.slice(0,16)){
      if(!value||typeof value!=='object')continue;
      if(typeof value.code==='string'&&/^(FONT_(NOT_SELECTED|FACE_UNAVAILABLE|GLYPH_MISSING|SHAPING_FAILED|ASSET_UNAVAILABLE|ASSET_HASH_MISMATCH|LICENSE_UNAVAILABLE|LICENSE_HASH_MISMATCH|CHECK_UNAVAILABLE)|INVALID_FONT_FILE)$/.test(value.code)){issues.push(fontIssue(value.code));continue;}
      if(value.code!=='LAYOUT_FAILED')continue;
      const bounded=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\x00-\x1f\x7f]/.test(v);
      if(!bounded(value.nodeId))continue;
      issues.push({code:'LAYOUT_FAILED',path:'nodes.'+value.nodeId,nodeId:value.nodeId,message:'Document content does not fit the configured layout',
       ...(bounded(value.sectionId)?{sectionId:value.sectionId}:{}),...(bounded(value.format)?{format:value.format}:{}),...(['omitted-destination','group-label-does-not-fit'].includes(value.reason)?{reason:value.reason}:{}),
       ...(bounded(value.groupId)?{groupId:value.groupId}:{}),...(Number.isSafeInteger(value.groupIndex)&&value.groupIndex>=0?{groupIndex:value.groupIndex}:{}),
       ...(Number.isSafeInteger(value.contentIndex)&&value.contentIndex>=0?{contentIndex:value.contentIndex}:{})});
     }
    }
   }catch{}
   resolve({ok:false,issues:issues.length?issues:[{code:'RENDER_FAILED',path:'job',message:'Document rendering failed or exceeded execution limits'}],warnings:code===1&&!failed?warnings:[]});
  };
  // The processor validates the pinned template before composing/preparing images.
  // Send only the branch the child consumes; retain composition for direct callers.
  child.on('error',()=>void finish(1));child.on('close',code=>void finish(code));child.stdin!.on('error',()=>{});
  const send=()=>{if(!failed){child.stdin!.end(payload.text);}payload.text='';};
  if(handle)void(async()=>{try{await handle.bind();await handle.start();send();}catch{failed=true;payload.text='';try{await handle!.stop('render start failure');}catch{uncertain();return;}await finish(1);}})();else send();
 });}finally{if(safeToRemove)await rm(temporary,{recursive:true,force:true});}
}

async function legacyGroupGone(group:number){
 for(const id of await readdir('/proc')){if(!/^\d+$/.test(id))continue;try{const stat=await readFile('/proc/'+id+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===group)return false;}catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
 return true;
}

export async function cleanupRenderTemps(root:string){const base=resolvePath(root);await mkdir(base,{recursive:true});for(const e of await readdir(base,{withFileTypes:true})){if(e.isDirectory()&&/^render-[a-zA-Z0-9]{6}$/.test(e.name))await rm(join(base,e.name),{recursive:true,force:true});}}
