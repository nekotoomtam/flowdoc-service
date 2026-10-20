import {it,expect} from 'vitest';
import {mkdtemp,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const api=await import('../dist/tasks/json-reader.js');
const budgetApi=await import('../dist/tasks/read-cache-budget.js').catch(()=>({}));
const fixture=async text=>{const dir=await mkdtemp(join(tmpdir(),'read-cache-'));const path=join(dir,'input.json');await writeFile(path,text);return path;};
const budget=()=>{expect(budgetApi.createReadBudget).toBeTypeOf('function');return budgetApi.createReadBudget();};
const collect=async v=>{const k=await v.kind();if(k==='scalar')return v.scalar();if(k==='array'){const a=[];for await(const x of v.elements())a.push(await collect(x));return a;}const o=Object.create(null);for await(const[k,x]of v.properties())o[k]=await collect(x);return o;};
it('shares windows across cursors, preserves values, and returns all credits on double close',async()=>{
 const b=budget(),value={thai:'ก'.repeat(12000),list:Array.from({length:40},(_,i)=>({i,text:'x'.repeat(300)}))},path=await fixture(JSON.stringify(value));
 const grant=await b.acquire('task-a'),r=await api.openTaskJson(path,undefined,{grant});
 try{for(let i=0;i<3;i++)expect(await collect(r.value)).toEqual(value);expect(r.stats().cacheHits).toBeGreaterThan(0);expect(r.stats().readCalls).toBeLessThan(10);expect(r.stats().peakCacheBytes).toBeLessThanOrEqual(1048576);}
 finally{await r.close();await r.close();}expect(b.snapshot().cacheBytes).toBe(0);expect(b.snapshot().readers).toBe(0);await expect(r.value.kind()).rejects.toThrow();
});
it('atomically caps task and instance grants; exhausted cache falls back without rejecting readers',async()=>{
 const b=budget(),grants=[];try{for(const id of ['a','a','b','c','d','e'])grants.push(await b.acquire(id));expect(grants.map(g=>g.cacheBytes)).toEqual([1048576,0,1048576,1048576,1048576,0]);expect(b.snapshot().cacheBytes).toBe(4194304);expect(b.snapshot().scratchBytes).toBe(6*16384);
 const path=await fixture('{"x":1}'),r=await api.openTaskJson(path,undefined,{grant:grants.at(-1)});expect(await collect(r.value)).toEqual({x:1});expect(r.stats().peakCacheBytes).toBe(0);await r.close();
 }finally{for(const g of grants)g.release();}expect(b.snapshot()).toMatchObject({cacheBytes:0,scratchBytes:0,readers:0});
});
it('checks abort on cache hits, preserves its reason and releases after a pending read settles',async()=>{
 const b=budget(),a=new AbortController(),reason=Object.assign(Error('cut'),{code:'CONNECTION_LOST'}),path=await fixture('{"x":"value"}');
 const r=await api.openTaskJson(path,a.signal,{grant:await b.acquire('a')});a.abort(reason);await expect(r.value.kind()).rejects.toBe(reason);await r.close();expect(b.snapshot().readers).toBe(0);
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);const raw=await open(path,'r'),c=new AbortController();
 const opening=api.openTaskJson(path,c.signal,{grant:await b.acquire('b'),readAt:async(...args)=>{entered();await gate;return raw.read(...args);}});await started;c.abort(reason);expect(b.snapshot().readers).toBe(1);release();await expect(opening).rejects.toBe(reason);await raw.close();expect(b.snapshot().readers).toBe(0);
});
it('uncached and cached modes preserve malformed JSON rejection, UTF8 boundaries and oversized working sets',async()=>{
 const b=budget();for(const cache of [false,true]){
 const text=JSON.stringify({padding:'x'.repeat(16370),thai:'ก😀"\\'.repeat(2000),rows:Array.from({length:80},(_,i)=>({i,s:'a'.repeat(16000)}))}),path=await fixture(text),r=await api.openTaskJson(path,undefined,{grant:await b.acquire('a',undefined,cache)});
 try{expect(await collect(r.value)).toEqual(JSON.parse(text));expect(r.stats().peakCacheBytes).toBeLessThanOrEqual(cache?1048576:0);}finally{await r.close();}
 for(const bad of ['{"x":1,}','{} {}','[true false]','{"a":"unterminated}','"'+ 'x'.repeat(393217)+'"'])await expect(api.openTaskJson(await fixture(bad),undefined,{grant:await b.acquire('a',undefined,cache)})).rejects.toThrow();
 }expect(b.snapshot().readers).toBe(0);
});
it('completes short reads, rejects premature EOF and invalidates a changed file before successful close',async()=>{
 const b=budget(),path=await fixture('{"x":"กกก"}'),raw=await open(path,'r');let calls=0;
 const r=await api.openTaskJson(path,undefined,{grant:await b.acquire('a'),readAt:(buf,off,len,pos)=>{calls++;return raw.read(buf,off,Math.min(3,len),pos);}});expect(await collect(r.value)).toEqual({x:'กกก'});expect(calls).toBeGreaterThan(3);await r.close();await raw.close();
 await expect(api.openTaskJson(path,undefined,{grant:await b.acquire('a'),readAt:async()=>({bytesRead:0})})).rejects.toThrow();
 const changed=await api.openTaskJson(path,undefined,{grant:await b.acquire('a')});await writeFile(path,'{}');await expect(changed.close()).rejects.toThrow();expect(b.snapshot().readers).toBe(0);
});
it('bounds readers and cancels an excess open waiter without losing permits',async()=>{
 const b=budget(),g=await Promise.all(Array.from({length:4},()=>b.acquire('a'))),a=new AbortController(),reason=Error('stopped');const waiting=b.acquire('a',a.signal);a.abort(reason);await expect(waiting).rejects.toBe(reason);for(const x of g)x.release();expect(b.snapshot().readers).toBe(0);
});
it('isolates concurrent cursors and readers, rejects reused grants without releasing their live owner',async()=>{
 const b=budget(),path=await fixture(JSON.stringify({a:'ก'.repeat(10000),b:[1,2,3]})),g=await b.acquire('owner'),r=await api.openTaskJson(path,undefined,{grant:g});
 try{await expect(api.openTaskJson(path,undefined,{grant:g})).rejects.toThrow();expect(b.snapshot().readers).toBe(1);const values=await Promise.all(Array.from({length:4},()=>collect(r.value)));expect(values.every(v=>v.a.length===10000&&v.b.length===3)).toBe(true);}finally{await r.close();}expect(b.snapshot().readers).toBe(0);
});
it('does not turn IO errors or aborts queued behind IO into cache misses',async()=>{
 const b=budget(),path=await fixture('{"a":1}'),io=Object.assign(Error('IO failed'),{code:'EIO'});
 await expect(api.openTaskJson(path,undefined,{grant:await b.acquire('a'),readAt:async()=>{throw io;}})).rejects.toBe(io);expect(b.snapshot().readers).toBe(0);
 const a=new AbortController(),r=await api.openTaskJson(path,a.signal,{grant:await b.acquire('a')});const reason=Error('end');a.abort(reason);await expect(collect(r.value)).rejects.toBe(reason);await r.close();expect(b.snapshot()).toMatchObject({cacheBytes:0,scratchBytes:0});
});
it('preserves parser limits and duplicate key iteration in both cache modes',async()=>{
 const b=budget();for(const cache of [false,true]){
 const path=await fixture('{"x":1,"x":2,"unknown":3}'),r=await api.openTaskJson(path,undefined,{grant:await b.acquire('a',undefined,cache)});try{const names=[];for await(const[k]of r.value.properties())names.push(k);expect(names).toEqual(['x','x','unknown']);}finally{await r.close();}
 for(const bad of ['['.repeat(66)+'0'+']'.repeat(66),'1'.repeat(129),'true null','[1,]','{"x" 1}'])await expect(api.openTaskJson(await fixture(bad),undefined,{grant:await b.acquire('a',undefined,cache)})).rejects.toThrow();
 }expect(b.snapshot().readers).toBe(0);
});
it('caps global reader scratch and admits blocked tasks after permits return',async()=>{
 const b=budget(),g=[];for(let i=0;i<16;i++)g.push(await b.acquire('task-'+i));expect(b.snapshot().scratchBytes).toBe(262144);let obtained=false;const wait=b.acquire('next').then(x=>{obtained=true;return x;});await new Promise(r=>setTimeout(r,5));expect(obtained).toBe(false);g[0].release();const next=await wait;expect(b.snapshot().readers).toBe(16);next.release();for(const x of g)x.release();expect(b.snapshot().waiters).toBe(0);
});
it('rejects a second queued miss after cancellation without releasing live IO credits early',async()=>{
 const b=budget(),a=new AbortController(),reason=Error('queued cancelled'),path=await fixture(JSON.stringify(Array.from({length:80},()=>({x:'a'.repeat(16000)})))),raw=await open(path,'r');
 let armed=false,release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const r=await api.openTaskJson(path,a.signal,{grant:await b.acquire('a'),readAt:async(...args)=>{if(armed){entered();await gate;}return raw.read(...args);}});
 armed=true;const first=r.value.kind().catch(e=>e);await started;const second=r.value.elements()[Symbol.asyncIterator]().next().catch(e=>e);await Promise.resolve();a.abort(reason);expect(b.snapshot().readers).toBe(1);release();expect(await first).toBe(reason);expect(await second).toBe(reason);await r.close();await raw.close();expect(b.snapshot()).toMatchObject({readers:0,cacheBytes:0,scratchBytes:0});
});
it('keeps same-offset bytes separate across tasks, files and reopened revisions',async()=>{
 const b=budget(),a=await fixture('{"name":"one"}'),c=await fixture('{"name":"two"}'),first=await api.openTaskJson(a,undefined,{grant:await b.acquire('a')}),other=await api.openTaskJson(c,undefined,{grant:await b.acquire('c')});
 try{expect(await collect(first.value)).toEqual({name:'one'});expect(await collect(other.value)).toEqual({name:'two'});await first.close();expect(b.snapshot().cacheBytes).toBe(1048576);await writeFile(a,'{"name":"new"}');const retry=await api.openTaskJson(a,undefined,{grant:await b.acquire('a')});try{expect(await collect(retry.value)).toEqual({name:'new'});expect(retry.stats().readCalls).toBeGreaterThan(0);}finally{await retry.close();}expect(await collect(other.value)).toEqual({name:'two'});}finally{await first.close();await other.close();}expect(b.snapshot().readers).toBe(0);
});
