import {mkdir,rename,unlink,readdir,stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {OperationError} from '../errors.js';
const owned=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin(?:\.part)?$/;
export async function createResourceFiles(directory:string){
 const root=resolve(directory);await mkdir(root,{recursive:true});
 const path=(name:string)=>{if(!owned.test(name))throw Error('Invalid resource name');return join(root,name);};
 const remove=async(name:string)=>{try{await unlink(path(name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
 return {
  remove,
  async exists(name:string,size:number){try{return (await stat(path(name))).size===size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}},
  async names(){return (await readdir(root)).filter(name=>owned.test(name));},
  async digest(input:AsyncIterable<Uint8Array>,expected:number,signal:AbortSignal,onProgress:()=>void){
   const hash=createHash('sha256');let count=0;
   await pipeline(input instanceof Readable?input:Readable.from(input),new Writable({write(chunk:Buffer,_e,done){
    count+=chunk.length;if(count>expected){done(new OperationError('BODY_TOO_LARGE','resource','Resource exceeds declared size'));return;}
    hash.update(chunk);onProgress();done();
   }}),{signal});
   if(count!==expected)throw new OperationError('UPLOAD_INCOMPLETE','resource','Resource size differs from declaration');
   return hash.digest('hex');
  },
  async receive(name:string,input:AsyncIterable<Uint8Array>,expected:number,signal:AbortSignal,onProgress?:(bytes:number)=>void){
   path(name);if(name.endsWith('.part'))throw Error('Invalid final name');
   const hash=createHash('sha256');let count=0;const temporary=name+'.part';
   const meter=new Transform({transform(chunk:Buffer,_encoding,done){
    count+=chunk.length;
    if(count>expected){done(new OperationError('BODY_TOO_LARGE','resource','Resource exceeds declared size'));return;}
    hash.update(chunk);onProgress?.(count);done(null,chunk);
   }});
   try{
    await pipeline(input instanceof Readable?input:Readable.from(input),meter,createWriteStream(path(temporary),{flags:'wx',mode:0o600}),{signal});
    if(count!==expected)throw new OperationError('UPLOAD_INCOMPLETE','resource','Resource size differs from declaration');
    await rename(path(temporary),path(name));return {name,byteSize:count,sha256:hash.digest('hex')};
   }finally{await remove(temporary);}
  }
 };
}
export type ResourceFiles=Awaited<ReturnType<typeof createResourceFiles>>;
