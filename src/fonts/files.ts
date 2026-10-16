import {mkdir,lstat,readFile,readdir,unlink,link,rename} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {resolve,join,relative,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {OperationError} from '../errors.js';
import {FONT_LIMITS,type FileDeclaration} from './types.js';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA=/^[0-9a-f]{64}$/;
const keyPattern=/^[A-Za-z0-9_-]{1,100}$/;
const fail=(code:string):never=>{throw new OperationError(code,'font','Font file operation did not succeed');};
async function directory(path:string){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('FONT_STORAGE_FAILED');}
export async function createFontFiles(location:string,options:{receiveTimeoutMs?:number}={}){
 const receiveTimeoutMs=options.receiveTimeoutMs??FONT_LIMITS.parseMs;
 if(!Number.isSafeInteger(receiveTimeoutMs)||receiveTimeoutMs<1||receiveTimeoutMs>FONT_LIMITS.parseMs)fail('INVALID_FONT_INPUT');
 const root=resolve(location),staging=join(root,'staging'),assets=join(root,'assets');
 await directory(root);await directory(staging);await directory(assets);
 const storagePath=(key:string)=>{if(!/^[0-9a-f]{64}\.bin$/.test(key))fail('INVALID_FONT_INPUT');return join(assets,key);};
 const entryPath=(id:string,key:string)=>{if(!UUID.test(id)||!keyPattern.test(key))fail('INVALID_FONT_INPUT');return join(staging,id,key+'.bin');};
 const remove=async(path:string)=>{try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
 async function digest(path:string){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size>FONT_LIMITS.fileBytes)fail('FONT_STORAGE_FAILED');const hash=createHash('sha256');for await(const b of createReadStream(path))hash.update(b);return {sha256:hash.digest('hex'),byteLength:s.size};}
 return {
  assetPath:storagePath,
  entryPath,
  async receive(id:string,key:string,input:AsyncIterable<Uint8Array>,expected:Pick<FileDeclaration,'byteLength'|'sha256'>,signal?:AbortSignal){
   const target=entryPath(id,key);if(!SHA.test(expected.sha256)||!Number.isSafeInteger(expected.byteLength)||expected.byteLength<1)fail('INVALID_FONT_INPUT');
   if(expected.byteLength>FONT_LIMITS.fileBytes)fail('FONT_LIMIT_EXCEEDED');
   await directory(join(staging,id));const temporary=join(staging,id,randomUUID()+'.part');
   let count=0;const hash=createHash('sha256');
   const meter=new Transform({transform(chunk:Buffer,_enc,done){count+=chunk.length;if(count>expected.byteLength){done(new OperationError('FONT_UPLOAD_INCOMPLETE','font','Font size differs from declaration'));return;}hash.update(chunk);done(null,chunk);}});
   try{
    const deadline=AbortSignal.timeout(receiveTimeoutMs);
    await pipeline(input instanceof Readable?input:Readable.from(input),meter,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal:signal?AbortSignal.any([signal,deadline]):deadline});
    if(count!==expected.byteLength)fail('FONT_UPLOAD_INCOMPLETE');const sha256=hash.digest('hex');if(sha256!==expected.sha256)fail('FONT_HASH_MISMATCH');
    await rename(temporary,target);return {path:target,sha256,byteLength:count};
   }finally{await remove(temporary);}
  },
  async verify(key:string,sha256:string,byteLength:number){try{const value=await digest(storagePath(key));return value.sha256===sha256&&value.byteLength===byteLength;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async promote(path:string,sha256:string){
   const parts=relative(staging,resolve(path)).split(sep);
   if(parts.length!==2||!UUID.test(parts[0]!)||!parts[1]!.endsWith('.bin')||!keyPattern.test(parts[1]!.slice(0,-4)))fail('INVALID_FONT_INPUT');
   if(!SHA.test(sha256))fail('INVALID_FONT_INPUT');const current=await digest(path);if(current.sha256!==sha256)fail('FONT_HASH_MISMATCH');
   const storageKey=sha256+'.bin',target=storagePath(storageKey);
   try{await link(path,target);return {storageKey,created:true};}
   catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const existing=await digest(target);if(existing.sha256!==sha256||existing.byteLength!==current.byteLength)fail('FONT_HASH_MISMATCH');return {storageKey,created:false};}
  },
  async readStaged(id:string,key:string){return readFile(entryPath(id,key));},
  async removeAsset(key:string){await remove(storagePath(key));},
  async assetKeys(){return (await readdir(assets)).filter(n=>/^[0-9a-f]{64}\.bin$/.test(n));},
  async stagingIds(){return (await readdir(staging)).filter(n=>UUID.test(n));},
  async clearStaging(id:string){
   if(!UUID.test(id))fail('INVALID_FONT_INPUT');const dir=join(staging,id);await directory(dir);let count=0;
   for(const name of await readdir(dir))if(/^[A-Za-z0-9_-]{1,100}\.bin$/.test(name)||/^[0-9a-f-]{36}\.part$/.test(name)){await remove(join(dir,name));count++;}
   return count;
  },
  async removeStaged(id:string,keys:string[]){for(const key of keys)await remove(entryPath(id,key));}
 };
}
export type FontFiles=Awaited<ReturnType<typeof createFontFiles>>;
