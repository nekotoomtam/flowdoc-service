/** Internal ephemeral credits. Only the Service parent delegates credits to a child. */
import {channel} from 'node:diagnostics_channel';
export const READ_WINDOW = 16384, TASK_READ_CACHE = 1048576, INSTANCE_READ_CACHE = 4194304;
export const TASK_FIELD_INDEX=262144, INSTANCE_FIELD_INDEX=1048576;
const limit = () => Object.assign(Error('Task reader bound exceeded'), {code:'LIMIT_EXCEEDED'});
export interface ReadGrant {readonly taskId:string;readonly cacheBytes:number;readonly indexBytes:number;claim():void;release():void}
export function delegatedReadGrant(taskId:string,cacheBytes:number,onRelease=()=>{},indexBytes=0):ReadGrant {
 if(!Number.isSafeInteger(cacheBytes)||cacheBytes<0||cacheBytes>TASK_READ_CACHE||cacheBytes%READ_WINDOW)throw limit();
 if(!Number.isSafeInteger(indexBytes)||indexBytes<0||indexBytes>TASK_FIELD_INDEX||indexBytes%4096)throw limit();
 let claimed=false,released=false;
 return {taskId,cacheBytes,indexBytes,claim(){if(claimed||released)throw limit();claimed=true;},release(){if(released)return;released=true;onRelease();}};
}
export function createReadBudget(){
 const tasks=new Map<string,{readers:number;cache:number;index:number}>();
 let readers=0,cacheBytes=0,indexBytes=0,peakIndexBytes=0,peakCacheBytes=0,peakReaders=0;
 const waiters:Array<{task:string;signal:AbortSignal|undefined;cache:boolean;index:boolean;resolve:(g:ReadGrant)=>void;reject:(e:unknown)=>void;abort:()=>void}>=[];
 const available=(task:string)=>readers<16&&(tasks.get(task)?.readers??0)<4;
 function grant(taskId:string,cache:boolean,index:boolean){
  const state=tasks.get(taskId)??{readers:0,cache:0,index:0};tasks.set(taskId,state);
  const bytes=cache?Math.min(TASK_READ_CACHE-state.cache,INSTANCE_READ_CACHE-cacheBytes):0;
  const indices=index?Math.min(TASK_FIELD_INDEX-state.index,INSTANCE_FIELD_INDEX-indexBytes):0;
  state.index+=indices;indexBytes+=indices;peakIndexBytes=Math.max(peakIndexBytes,indexBytes);
  state.readers++;state.cache+=bytes;readers++;cacheBytes+=bytes;
  peakCacheBytes=Math.max(peakCacheBytes,cacheBytes);peakReaders=Math.max(peakReaders,readers);
  const report=()=>channel('flowdoc.task.read.budget').publish({taskId,readers,cacheBytes,indexBytes,scratchBytes:readers*READ_WINDOW});report();
  return delegatedReadGrant(taskId,bytes,()=>{
   state.index-=indices;indexBytes-=indices;state.readers--;state.cache-=bytes;readers--;cacheBytes-=bytes;if(!state.readers)tasks.delete(taskId);
   report();
   for(let i=0;i<waiters.length;){const w=waiters[i]!;if(!available(w.task)){i++;continue;}waiters.splice(i,1);w.signal?.removeEventListener('abort',w.abort);w.resolve(grant(w.task,w.cache,w.index));}
  },indices);
 }
 return {
  async acquire(task:string,signal?:AbortSignal,cache=process.env.FLOWDOC_TASK_READ_CACHE!=='off',index=process.env.FLOWDOC_TASK_FIELD_INDEX!=='off'):Promise<ReadGrant>{
   signal?.throwIfAborted();if(available(task))return grant(task,cache,index);if(waiters.length>=16)throw limit();
   return new Promise((resolve,reject)=>{const w={task,signal,cache,index,resolve,reject,abort:()=>{const i=waiters.indexOf(w);if(i>=0)waiters.splice(i,1);reject(signal!.reason);}};waiters.push(w);signal?.addEventListener('abort',w.abort,{once:true});if(signal?.aborted)w.abort();});
  },
  snapshot:()=>({readers,cacheBytes,indexBytes,peakIndexBytes,scratchBytes:readers*READ_WINDOW,peakCacheBytes,peakScratchBytes:peakReaders*READ_WINDOW,waiters:waiters.length})
 };
}
// Shared by parent normalization and rendering, never auto-used as a child cache grant.
export const taskReadBudget=createReadBudget();
