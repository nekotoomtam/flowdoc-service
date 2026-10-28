import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {OperationError} from '../errors.js';
import type {createQueueResources} from '../tasks/queue-resources.js';
type Resources=Pick<Awaited<ReturnType<typeof createQueueResources>>,'enabled'|'ready'|'tryAcquire'>;
const unavailable=()=>new OperationError('UNAVAILABLE','font','Native font check unavailable; retry later');
/** Fail-fast: no native waiters hold database connections or resource credits.
 * Actual-input callers must supply their checked-out transaction client. The
 * nonblocking database permit also bounds native checks across service processes.
 */
export function createFontPreflightGate(resources?:Resources){
 type Waiting={signal:AbortSignal|undefined;work:()=>Promise<unknown>;resolve:(value:any)=>void;reject:(error:unknown)=>void;cancel:()=>void;timer?:NodeJS.Timeout};
 const waiting:Waiting[]=[];let admitting=false,admissionDone:Promise<void>|undefined;
 const rejectWaiting=(w:Waiting,error:unknown)=>{const i=waiting.indexOf(w);if(i>=0)waiting.splice(i,1);clearTimeout(w.timer);w.signal?.removeEventListener('abort',w.cancel);w.reject(error);};
 function drain(){if(admitting||closing||poisoned)return;const w=waiting.shift();if(!w)return;clearTimeout(w.timer);w.signal?.removeEventListener('abort',w.cancel);admitting=true;admissionDone=Promise.resolve().then(w.work).then(w.resolve,w.reject).finally(()=>{admitting=false;admissionDone=undefined;drain();});}
 let active:{abort:AbortController;done:Promise<void>}|undefined,closing=false,poisoned=false;
 return {
  isReady:()=>!closing&&!poisoned,
  admit<T>(signal:AbortSignal|undefined,maxWaiting:number,work:()=>Promise<T>):Promise<T>{
   if(closing||poisoned||signal?.aborted)return Promise.reject(unavailable());
   if(waiting.length>=maxWaiting)return Promise.reject(new OperationError('QUEUE_FULL','font','Font admission queue is full; retry later'));
   return new Promise<T>((resolve,reject)=>{const w:Waiting={signal,work,resolve,reject,cancel:()=>rejectWaiting(w,unavailable())};waiting.push(w);w.timer=setTimeout(()=>rejectWaiting(w,unavailable()),120000);signal?.addEventListener('abort',w.cancel,{once:true});if(signal?.aborted)w.cancel();else drain();});
  },
  async run<T>(client:Pick<PoolClient,'query'>,signal:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
   if(closing||poisoned||active||signal?.aborted)throw unavailable();
   const abort=new AbortController();let complete!:()=>void;const state={abort,done:new Promise<void>(r=>{complete=r;})};active=state;
   const cancelled=()=>abort.abort(unavailable());signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted)cancelled();
   let grant:{release():void}|undefined,confirmed=true;
   try{
    abort.signal.throwIfAborted();
    const permit=await client.query('SELECT pg_try_advisory_xact_lock(60430407) AS locked');if(permit.rows[0]?.locked!==true)throw unavailable();
    if(resources?.enabled()){
     if(!resources.ready())throw unavailable();
     grant=resources.tryAcquire('font-preflight:'+randomUUID(),{kind:'worker',order:Date.now(),expiresAt:Date.now()+125000,signal:abort.signal,onStop:()=>abort.abort(unavailable())})??undefined;
     if(!grant)throw unavailable();
    }
    abort.signal.throwIfAborted();const value=await work(abort.signal);abort.signal.throwIfAborted();return value;
   }catch(e){
    if((e as any)?.code==='WORKER_STOP_UNCONFIRMED'){confirmed=false;poisoned=true;for(const w of [...waiting])rejectWaiting(w,unavailable());throw unavailable();}
    if(abort.signal.aborted||e instanceof OperationError)throw unavailable();throw e;
   }finally{signal?.removeEventListener('abort',cancelled);if(confirmed)grant?.release();active=undefined;complete();}
  },
  async stop(){closing=true;for(const w of [...waiting])rejectWaiting(w,unavailable());const pendingAdmission=admissionDone;const current=active;current?.abort.abort(unavailable());await current?.done;await pendingAdmission;if(poisoned)throw unavailable();}
 };
}
export type FontPreflightGate=ReturnType<typeof createFontPreflightGate>;
export const defaultFontPreflightGate=createFontPreflightGate();
