import {mkdir,writeFile,rename,unlink,readdir,stat,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validJobId} from '../jobs/repository.js';
export interface FilePolicy {retain:boolean;ttlHours:number;tempHours:number}
export function readFilePolicy(env:NodeJS.ProcessEnv):FilePolicy{
 const flag=env.EXPORT_RETAIN_FILES??'false';if(!['true','false'].includes(flag))throw Error('Invalid retention flag');
 const hours=(value:string|undefined)=>{const n=Number(value??24);if(!Number.isFinite(n)||n<=0||n>8760)throw Error('Invalid file lifetime');return n;};
 const tempHours=hours(env.EXPORT_TEMP_FILE_TTL_HOURS);const retainedHours=hours(env.EXPORT_FILE_TTL_HOURS);
 return {retain:flag==='true',ttlHours:flag==='true'?retainedHours:tempHours,tempHours};
}
const owned=/^[0-9a-f-]{36}\.pdf(?:\.[0-9a-f-]{36}\.tmp)?$/i;
export async function createPdfFiles(directory:string){
 const root=resolve(directory);await mkdir(root,{recursive:true});const active=new Set<string>();
 function path(name:string){if(!owned.test(name))throw Error('Invalid output name');return join(root,name);}
 return {
  async writePdf(id:string,bytes:Uint8Array){
   if(!validJobId(id))throw Error('Invalid job ID');const name=id+'.pdf',temp=name+'.'+randomUUID()+'.tmp';active.add(temp);active.add(name);
   try{await writeFile(path(temp),bytes,{flag:'wx',mode:0o600});await rename(path(temp),path(name));return {path:name,byteSize:bytes.length,release:()=>{active.delete(name);}};}
   catch(e){active.delete(name);throw e;}finally{active.delete(temp);await unlink(path(temp)).catch(()=>{});}
  },
  async clearRetired(name:string){try{await unlink(path(name)+'.retired');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  async markRetired(name:string){await writeFile(path(name)+'.retired','consumed',{mode:0o600});},
  async isRetired(name:string){try{await stat(path(name)+'.retired');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async openPdf(name:string){const handle=await open(path(name),'r');return handle.createReadStream();},
  async remove(name:string){try{await unlink(path(name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  async cleanupOrphans(referenced:Set<string>,ageMs:number){for(const name of await readdir(root)){if(!owned.test(name)||active.has(name)||referenced.has(name))continue;const s=await stat(path(name));if(s.isFile()&&Date.now()-s.mtimeMs>=ageMs)await this.remove(name);}}
 };
}
export type PdfFiles=Awaited<ReturnType<typeof createPdfFiles>>;
