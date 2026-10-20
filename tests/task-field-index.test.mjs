import {it,expect} from 'vitest';
import {mkdtemp,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openTaskJson} from '../dist/tasks/json-reader.js';
import {createReadBudget,delegatedReadGrant} from '../dist/tasks/read-cache-budget.js';
const fixture=async text=>{const dir=await mkdtemp(join(tmpdir(),'field-index-'));const path=join(dir,'input.json');await writeFile(path,text);return path;};
const fields=async v=>{const result=[];for await(const[k,x]of v.properties())result.push([k,await x.kind()==='scalar'?await x.scalar():await x.byteLength()]);return result;};
it('reuses offsets without rescanning nested values, preserving duplicates, order and missing fields',async()=>{
 const b=createReadBudget(),p=await fixture('{"a":{"nested":"'+'ก'.repeat(4000)+'"},"x":1,"x":2,"unknown":null}');
 const r=await openTaskJson(p,undefined,{grant:await b.acquire('one',undefined,true,true)});
 try{const first=await fields(r.value),scanned=r.stats().fieldScanBytes;expect(first.map(x=>x[0])).toEqual(['a','x','x','unknown']);expect(first.filter(x=>x[0]==='x')).toEqual([['x',1],['x',2]]);expect(await fields(r.value)).toEqual(first);expect(r.stats().fieldScanBytes).toBe(scanned);expect(r.stats().fieldIndexHits).toBeGreaterThan(0);expect(first.find(x=>x[0]==='missing')).toBeUndefined();}
 finally{await r.close();}expect(r.stats().currentIndexBytes).toBe(0);expect(b.snapshot().indexBytes).toBe(0);
});
it('shares a hard task/instance index budget and falls back when no credit remains',async()=>{
 const b=createReadBudget(),g=[];try{for(const id of ['a','a','b','c','d','e'])g.push(await b.acquire(id,undefined,true,true));expect(g.map(x=>x.indexBytes)).toEqual([262144,0,262144,262144,262144,0]);expect(b.snapshot().indexBytes).toBe(1048576);const r=await openTaskJson(await fixture('{"x":1}'),undefined,{grant:g.at(-1)});expect(await fields(r.value)).toEqual([['x',1]]);expect(r.stats().fieldIndexFallbacks).toBeGreaterThan(0);await r.close();}finally{g.forEach(x=>x.release());}expect(b.snapshot().indexBytes).toBe(0);
});
it('falls back for oversized objects and keeps partial iteration, eviction and held iterators correct',async()=>{
 const b=createReadBudget(),value=Object.fromEntries(Array.from({length:300},(_,i)=>['k'+i,i])),r=await openTaskJson(await fixture(JSON.stringify(value)),undefined,{grant:await b.acquire('large',undefined,true,true)});
 try{expect(await fields(r.value)).toEqual(Object.entries(value));expect(await fields(r.value)).toEqual(Object.entries(value));expect(r.stats().fieldIndexFallbacks).toBeGreaterThan(0);expect(r.stats().peakIndexBytes).toBeLessThanOrEqual(262144);}finally{await r.close();}
 const p=await fixture(JSON.stringify({root:1,rows:Array.from({length:100},(_,i)=>({i,x:i+1}))})),s=await openTaskJson(p,undefined,{grant:await b.acquire('evict',undefined,true,true)});
 try{const held=s.value.properties()[Symbol.asyncIterator]();expect((await held.next()).value[0]).toBe('root');let rows;for await(const[k,v]of s.value.properties())if(k==='rows')rows=v;for await(const row of rows.elements())expect((await fields(row))[0][0]).toBe('i');expect((await held.next()).value[0]).toBe('rows');await held.return();expect(s.stats().fieldIndexEvictions).toBeGreaterThan(0);expect(s.stats().peakIndexBytes).toBeLessThanOrEqual(262144);}finally{await s.close();}
});
it('drops indices on abort/close and isolates files and attempts even at identical offsets',async()=>{
 const b=createReadBudget(),a=new AbortController(),r=await openTaskJson(await fixture('{"x":1}'),a.signal,{grant:await b.acquire('a',undefined,true,true)}),other=await openTaskJson(await fixture('{"x":2}'),undefined,{grant:await b.acquire('b',undefined,true,true)});
 await fields(r.value);const reason=Error('cancel');a.abort(reason);await expect(fields(r.value)).rejects.toBe(reason);await r.close();expect(r.stats().currentIndexBytes).toBe(0);expect(await fields(other.value)).toEqual([['x',2]]);await other.close();expect(b.snapshot().indexBytes).toBe(0);
 expect(()=>delegatedReadGrant('bad',0,()=>{},262145)).toThrow();
});
it('falls back with every slot pinned, and never exposes evicted or closed tables',async()=>{
 const r=await openTaskJson(await fixture('{"a":1,"nested":{"b":2}}'),undefined,{grant:delegatedReadGrant('one-slot',0,()=>{},4096)});
 const held=r.value.properties()[Symbol.asyncIterator]();expect((await held.next()).value[0]).toBe('a');const nested=(await held.next()).value[1];expect(await fields(nested)).toEqual([['b',2]]);expect(r.stats().fieldIndexFallbacks).toBeGreaterThan(0);expect(r.stats().peakIndexBytes).toBe(4096);await r.close();await expect(held.next()).rejects.toThrow();expect(r.stats().currentIndexBytes).toBe(0);
});
it('preserves Unicode keys, boundary counts, parser limits and fallback results with indexing off/on',async()=>{
 for(const enabled of [false,true]){const b=createReadBudget(),value=Object.fromEntries(Array.from({length:256},(_,i)=>['ก😀/~'+i,i])),r=await openTaskJson(await fixture(JSON.stringify(value)),undefined,{grant:await b.acquire('boundary',undefined,true,enabled)});
 try{expect(await fields(r.value)).toEqual(Object.entries(value));expect(await fields(r.value)).toEqual(Object.entries(value));}finally{await r.close();}
 const bad=await openTaskJson(await fixture('{"'+ 'x'.repeat(1537)+'":1}'),undefined,{grant:await b.acquire('limit',undefined,true,enabled)});try{await expect(fields(bad.value)).rejects.toThrow();}finally{await bad.close();}expect(b.snapshot().indexBytes).toBe(0);}
});
it('releases an in-progress index only after cancelled file IO drains',async()=>{
 const path=await fixture(JSON.stringify({data:Array.from({length:80},()=>({v:'x'.repeat(16000)}))})),raw=await open(path,'r'),b=createReadBudget(),a=new AbortController();
 let armed=false,calls=0,release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const reader=await openTaskJson(path,a.signal,{grant:await b.acquire('build',undefined,true,true),readAt:async(...args)=>{if(armed&&++calls===2){entered();await gate;}return raw.read(...args);}});
 armed=true;const pending=fields(reader.value).catch(e=>e);await started;expect(reader.stats().currentIndexBytes).toBe(4096);const reason=Error('cancel build');a.abort(reason);expect(reader.stats().currentIndexBytes).toBe(0);expect(b.snapshot().indexBytes).toBe(262144);release();expect(await pending).toBe(reason);await reader.close();await raw.close();expect(b.snapshot().indexBytes).toBe(0);
});
