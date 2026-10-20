import{it,expect}from'vitest';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{openTaskJson}from'../dist/tasks/json-reader.js';import{createQueueResources}from'../dist/tasks/queue-resources.js';
import{createReadBudget}from'../dist/tasks/read-cache-budget.js';
const MiB=1048576,wait=ms=>new Promise(r=>setTimeout(r,ms));
it('lets cancellation timers interrupt repeated retained-record scans, returning all reader credits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'queue-cancel-')),path=join(dir,'input.json'),a=new AbortController(),budget=createReadBudget();let r,lease,timer;
 try{await writeFile(path,JSON.stringify({value:'x'.repeat(50000)}));r=await openTaskJson(path,a.signal,{grant:await budget.acquire('cancel',a.signal,true,false,true)});lease=await r.value.retainRecord();const reason=Object.assign(Error('cancel'),{code:'CONNECTION_LOST'});timer=setTimeout(()=>a.abort(reason),1);let error;
 try{for(let n=0;n<20;n++)for await(const[k,v]of lease.value.properties())await v.scalar();}catch(e){error=e;}
 expect(error).toBe(reason);
 }finally{clearTimeout(timer);lease?.release();await r?.close();expect(budget.snapshot()).toMatchObject({readers:0,cacheBytes:0,indexBytes:0,recordBytes:0});await rm(dir,{recursive:true,force:true});}
});
it('services timers while scanning cached JSON and retained records, without changing values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'queue-timing-'));let r;
 try{const text=JSON.stringify({rows:Array.from({length:10},()=>({value:'x'.repeat(50000)}))});const path=join(dir,'input.json');await writeFile(path,text);r=await openTaskJson(path);
 let timers=0;const timer=setInterval(()=>timers++,1);try{for(let n=0;n<3;n++){const rows=await (async()=>{for await(const[k,v]of r.value.properties())if(k==='rows')return v;})();let count=0;for await(const row of rows.elements()){const lease=await row.retainRecord();try{for await(const[k,v]of lease.value.properties())if(k==='value')expect((await v.scalar()).length).toBe(50000);}finally{lease.release();}count++;}expect(count).toBe(10);}expect(timers).toBeGreaterThan(3);expect(r.stats().cooperativeYields).toBeGreaterThan(0);}finally{clearInterval(timer);}
 }finally{await r?.close();await rm(dir,{recursive:true,force:true});}
});
it('records bounded timing diagnostics and separately reports missing metrics',async()=>{
 let fail=false;const r=await createQueueResources({sampleMs:10,readMemory:async()=>{if(fail)throw Error('read failure');return{current:100*MiB,max:1024*MiB};}});
 try{fail=true;await wait(40);const d=r.snapshot().timing;expect(d.readErrors).toBeGreaterThan(0);expect(d.lastFailure).toBe('read_error');expect(d.readMs.buckets).toHaveLength(9);expect(d.scheduleLagMs.buckets).toHaveLength(9);expect(r.ready()).toBe(false);}finally{await r.stop();}
});
it('does not hide a missed freshness deadline by accepting a later successful read',async()=>{
 const stops=[];const r=await createQueueResources({sampleMs:10,readMemory:async()=>({current:100*MiB,max:1024*MiB})});
 try{const g=await r.acquire('w',{kind:'worker',order:0,expiresAt:Date.now()+5000,onStop:c=>stops.push(c)});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,550);await wait(30);expect(stops).toEqual(['UNAVAILABLE']);expect(r.snapshot().timing.staleStops).toBe(1);g.release();}finally{await r.stop();}
});
it('bounds underlying hung reads to one and stops active work at the original freshness deadline',async()=>{
 let calls=0;const stops=[];const r=await createQueueResources({sampleMs:10,readMemory:async()=>{if(++calls>1)return new Promise(()=>{});return{current:100*MiB,max:1024*MiB};}});
 try{const g=await r.acquire('w',{kind:'worker',order:0,expiresAt:Date.now()+5000,onStop:c=>stops.push(c)});await wait(1250);expect(stops).toEqual(['UNAVAILABLE']);expect(calls).toBe(2);expect(r.snapshot().timing.lastFailure).toBe('read_timeout');g.release();}finally{await r.stop();}
});
