import {mkdir,lstat,open,rename,unlink,readdir,statfs} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {taskError} from './quota.js';
const id=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export async function taskFiles(directory:string,removeOverride?:(path:string)=>Promise<void>){
 const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});if((await lstat(root)).isSymbolicLink())throw taskError('STORAGE_IO');
 const folder=async(taskId:string)=>{if(!id.test(taskId))throw taskError('INVALID_REQUEST');let p=root;for(const segment of [taskId,'input']){p=join(p,segment);await mkdir(p,{recursive:true,mode:0o700});const s=await lstat(p);if(s.isSymbolicLink()||!s.isDirectory())throw taskError('STORAGE_IO');}return p;};
 const path=async(key:string)=>{const [taskId,sub,name,...rest]=key.split('/');if(rest.length||!taskId||sub!=='input'||!name||!/^([0-9a-f-]{36})\.bin(?:\.part)?$/.test(name)||!id.test(name.slice(0,36)))throw taskError('STORAGE_IO');return join(await folder(taskId),name);};
 return {root,path,async freeBytes(){const s=await statfs(root,{bigint:true});return Number(s.bavail*s.bsize);},
  async open(key:string){return open(await path(key),'wx',0o600);},
  async publish(key:string){const target=key.replace(/\.part$/,'');await rename(await path(key),await path(target));return target;},
  async remove(key:string){const p=await path(key);try{if(removeOverride)await removeOverride(p);else await unlink(p);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  async size(key:string){try{const s=await lstat(await path(key));if(!s.isFile()||s.isSymbolicLink())throw taskError('STORAGE_IO');return s.size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}},
  async names(taskId:string){return (await readdir(await folder(taskId))).filter(n=>/^([0-9a-f-]{36})\.bin(?:\.part)?$/.test(n)).map(n=>taskId+'/input/'+n);}
 };
}
