import {mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import {join,resolve as resolvePath} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {PreparedInput,TemplateDefinition,Result,PdfArtifact} from '@flowdoc/core';
export async function renderPinnedJob(prepared:PreparedInput,template:TemplateDefinition,signal?:AbortSignal,deadlineMs=120000,maxBytes=52428800,tempRoot=join(tmpdir(),'flowdoc-job-renders')):Promise<Result<Pick<PdfArtifact,"bytes"|"mediaType">>>{
 const root=resolvePath(tempRoot);await mkdir(root,{recursive:true});const temporary=await mkdtemp(join(root,'render-'));
 try{return await new Promise<Result<Pick<PdfArtifact,'bytes'|'mediaType'>>>(resolve=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./render-child.js',import.meta.url))],{stdio:['pipe','pipe','ignore'],detached:process.platform!=='win32',env:{FLOWDOC_RENDER_TEMP:temporary,PATH:process.env.PATH,...(process.env.PYTHON_EXECUTABLE?{PYTHON_EXECUTABLE:process.env.PYTHON_EXECUTABLE}:{})}});
  const chunks:Buffer[]=[];let size=0,failed=false,done=false;
  const kill=()=>{failed=true;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const timer=setTimeout(kill,deadlineMs);signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes)kill();else chunks.push(chunk);});
  const finish=(code:number|null)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',kill);const bytes=Buffer.concat(chunks);resolve(code===0&&!failed&&bytes.subarray(0,5).toString()==='%PDF-'?{ok:true,value:{bytes,mediaType:'application/pdf'},warnings:[]}:{ok:false,issues:[{code:'RENDER_FAILED',path:'job',message:'Document rendering failed or exceeded execution limits'}],warnings:[]});};
  child.on('error',()=>finish(1));child.on('close',finish);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({template,prepared}));
 });}finally{await rm(temporary,{recursive:true,force:true});}
}

export async function cleanupRenderTemps(root:string){const base=resolvePath(root);await mkdir(base,{recursive:true});for(const e of await readdir(base,{withFileTypes:true})){if(e.isDirectory()&&/^render-[a-zA-Z0-9]{6}$/.test(e.name))await rm(join(base,e.name),{recursive:true,force:true});}}
