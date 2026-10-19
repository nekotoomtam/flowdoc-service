import type {FileHandle} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {channel} from 'node:diagnostics_channel';
import {READ_WINDOW,type ReadGrant} from './read-cache-budget.js';
const invalid=()=>Object.assign(Error('Invalid staged JSON'),{code:'INVALID_DATA'});
export type ReadAt=(buffer:Buffer,offset:number,length:number,position:number)=>Promise<{bytesRead:number}>;
/** One scratch window; cursors retain offsets only. Cache buffers never escape. */
export function taskReadWindows(file:FileHandle,initial:Stats,grant:ReadGrant,signal?:AbortSignal,readAt:ReadAt=file.read.bind(file),onClose=()=>{},extraStats:()=>Record<string,number>=()=>({})){
 const size=initial.size;
 let scratch:Buffer|undefined=Buffer.allocUnsafeSlow(READ_WINDOW),scratchStart=-1,scratchLength=0,clock=0,closing=false;
 const entries=new Map<number,{buffer:Buffer;length:number;used:number}>();
 let tail:Promise<unknown>=Promise.resolve(),queued=0,closePromise:Promise<void>|undefined;
 const stats={readCalls:0,returnedBytes:0,cacheHits:0,cacheMisses:0,evictions:0,bypasses:0,peakCacheBytes:0,currentCacheBytes:0,scratchBytes:READ_WINDOW};
 const check=()=>{signal?.throwIfAborted();if(closing)throw invalid();};
 async function identity(){const b=await file.stat();if(initial.dev!==b.dev||initial.ino!==b.ino||initial.size!==b.size||initial.mtimeMs!==b.mtimeMs||initial.ctimeMs!==b.ctimeMs)throw invalid();}
 async function fill(buffer:Buffer,start:number){
  await identity();check();const expected=Math.min(READ_WINDOW,size-start);let n=0;
  while(n<expected){check();const r=await readAt(buffer,n,expected-n,start+n);stats.readCalls++;stats.returnedBytes+=r.bytesRead;check();if(r.bytesRead<=0||r.bytesRead>expected-n)throw invalid();n+=r.bytesRead;}
  return n;
 }
 function serial<T>(f:()=>Promise<T>):Promise<T>{
  check();if(queued>=16)throw Object.assign(Error('Reader operation bound exceeded'),{code:'LIMIT_EXCEEDED'});queued++;
  const op=tail.then(()=>{check();return f();});tail=op.catch(()=>{}).finally(()=>{queued--;});return op;
 }
 async function window<T>(pos:number,use:(b:Buffer,index:number,length:number)=>T):Promise<T>{
  check();const start=Math.floor(pos/READ_WINDOW)*READ_WINDOW,found=entries.get(start);
  if(found){stats.cacheHits++;found.used=++clock;return use(found.buffer,pos-start,found.length);}
  if(!grant.cacheBytes&&scratchStart===start)return use(scratch!,pos-start,scratchLength);
  return serial(async()=>{
   const existing=entries.get(start);if(existing){stats.cacheHits++;existing.used=++clock;return use(existing.buffer,pos-start,existing.length);}
   stats.cacheMisses++;
   if(grant.cacheBytes){
    let buffer:Buffer;
    if(entries.size>=grant.cacheBytes/READ_WINDOW){let oldest=-1,min=Infinity;for(const [k,e]of entries)if(e.used<min){oldest=k;min=e.used;}buffer=entries.get(oldest)!.buffer;entries.delete(oldest);stats.evictions++;}
    else {buffer=Buffer.allocUnsafeSlow(READ_WINDOW);stats.peakCacheBytes=Math.max(stats.peakCacheBytes,(entries.size+1)*READ_WINDOW);}
    // All access/copies are synchronous inside `use`; no borrowed window survives it.
    const length=await fill(buffer,start);check();entries.set(start,{buffer,length,used:++clock});stats.currentCacheBytes=entries.size*READ_WINDOW;stats.peakCacheBytes=Math.max(stats.peakCacheBytes,stats.currentCacheBytes);
    return use(buffer,pos-start,length);
   }
   stats.bypasses++;if(scratchStart!==start){scratchStart=-1;scratchLength=await fill(scratch!,start);scratchStart=start;}check();return use(scratch!,pos-start,scratchLength);
  });
 }
 const byte=async(pos:number)=>{check();if(pos>=size)return -1;return window(pos,(b,i,n)=>{if(i>=n)throw invalid();return b[i]!;});};
 const text=async(start:number,end:number)=>{
  check();if(start<0||end<start||end>size||end-start>393218)throw invalid();const out=Buffer.alloc(end-start);
  for(let pos=start;pos<end;){const n=await window(pos,(b,i,length)=>{const n=Math.min(end-pos,length-i);if(n<=0)throw invalid();b.copy(out,pos-start,i,i+n);return n;});pos+=n;}
  check();return out.toString('utf8');
 };
 function close(){
  if(closePromise)return closePromise;closing=true;onClose();
  closePromise=(async()=>{try{await tail;if(!signal?.aborted)await identity();}finally{entries.clear();scratch=undefined;stats.currentCacheBytes=0;stats.scratchBytes=0;signal?.removeEventListener('abort',onAbort);try{await file.close();}finally{grant.release();channel('flowdoc.task.read').publish({taskId:grant.taskId,cacheLimit:grant.cacheBytes,indexLimit:grant.indexBytes,...stats,...extraStats()});}}})();return closePromise;
 }
 const onAbort=()=>{void close().catch(()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
 return {byte,text,close,check,stats:()=>({...stats,...extraStats()})};
}
