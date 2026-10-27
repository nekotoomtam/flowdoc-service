import {mkdir,lstat,open,rename,unlink,readdir,statfs,rmdir} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {taskError} from './quota.js';
const id=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export async function taskFiles(directory:string,removeOverride?:(path:string)=>Promise<void>){
 const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())throw taskError('STORAGE_IO');
 const subfolders=['input','normalized','prepared','output','work'];
 const retiring=new Map<string,Promise<boolean>>();
 async function checkDirectory(p:string,create=false){
  if(create)await mkdir(p,{recursive:true,mode:0o700});
  try{const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())throw taskError('STORAGE_IO');return true;}
  catch(e){if(!create&&(e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
 }
 const folder=async(taskId:string,sub='input',create=false)=>{if(!id.test(taskId))throw taskError('INVALID_REQUEST');await checkDirectory(root);let p=root;for(const segment of [taskId,sub]){p=join(p,segment);await checkDirectory(p,create);}return p;};
 const path=async(key:string,create=false)=>{const [taskId,sub,name,...rest]=key.split('/');if(rest.length||!taskId||!['input','normalized','prepared','output'].includes(sub??'')||!name||!/^([0-9a-f-]{36})\.bin(?:\.part)?$/.test(name)||!id.test(name.slice(0,36)))throw taskError('STORAGE_IO');return join(await folder(taskId,sub,create),name);};
 return {root,path,workspace:(taskId:string,create=true)=>folder(taskId,'work',create),async freeBytes(){const s=await statfs(root,{bigint:true});return Number(s.bavail*s.bsize);},
  async open(key:string){return open(await path(key,true),'wx',0o600);},
  async publish(key:string){const target=key.replace(/\.part$/,'');await rename(await path(key),await path(target));return target;},
  async remove(key:string){const p=await path(key);try{if(removeOverride)await removeOverride(p);else await unlink(p);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  async size(key:string){try{const s=await lstat(await path(key));if(!s.isFile()||s.isSymbolicLink())throw taskError('STORAGE_IO');return s.size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}},
  async names(taskId:string){const keys:string[]=[];for(const sub of ['input','normalized','prepared','output']){const p=await folder(taskId,sub);let names:string[];try{names=await readdir(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}keys.push(...names.filter(n=>/^([0-9a-f-]{36})\.bin(?:\.part)?$/.test(n)).map(n=>taskId+'/'+sub+'/'+n));}return keys;},
  /** Terminal owner calls this only after all workers, senders and files are released. */
  async removeEmptyDirectories(taskId:string){
   if(!id.test(taskId))throw taskError('INVALID_REQUEST');const existing=retiring.get(taskId);if(existing)return existing;
   const pending=(async()=>{await checkDirectory(root);const taskRoot=join(root,taskId);
   if(!await checkDirectory(taskRoot))return true;
   let names:string[];try{names=await readdir(taskRoot);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return true;throw e;}
   if(names.some(n=>!subfolders.includes(n)))return false;
   // Check every existing child before mutation; never follow links or delete files.
   for(const n of names)await checkDirectory(join(taskRoot,n));
   let empty=true;
   for(const p of [...names.map(n=>join(taskRoot,n)),taskRoot])try{await rmdir(p);}catch(e){const code=(e as NodeJS.ErrnoException).code;if(code==='ENOENT')continue;if(code==='ENOTEMPTY'||code==='EEXIST'){empty=false;continue;}throw e;}
   return empty;})();
   retiring.set(taskId,pending);try{return await pending;}finally{retiring.delete(taskId);}
  }
 };
}
export type TaskFileStore=Awaited<ReturnType<typeof taskFiles>>;
