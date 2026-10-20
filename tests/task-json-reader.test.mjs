import {it,expect} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const api=await import('../dist/tasks/json-reader.js').catch(()=>({}));
const collect=async v=>{const kind=await v.kind();if(kind==='scalar')return v.scalar();if(kind==='array'){const a=[];for await(const x of v.elements())a.push(await collect(x));return a;}const o={};for await(const [k,x] of v.properties())o[k]=await collect(x);return o;};
it('reads a file-backed JSON tree with escaped Thai keys and no container scalar reads',async()=>{
 expect(api.openTaskJson).toBeTypeOf('function');const root=await mkdtemp(join(tmpdir(),'task-json-')),file=join(root,'input.json'),q={'รูป/~':[{},[],true,false,null,1.25,-2e3,'a\\b\"c',{'nested':['ก']}],text:'x'.repeat(65536)};await writeFile(file,JSON.stringify(q));const source=await api.openTaskJson(file);
 try{expect(await collect(source.value)).toEqual(q);await expect(source.value.scalar()).rejects.toThrow();}finally{await source.close();}
});
it('iterates a large array incrementally and bounds malformed or excessive scalars',async()=>{
 const root=await mkdtemp(join(tmpdir(),'task-json-')),file=join(root,'input.json');await writeFile(file,'['+Array.from({length:10000},(_,i)=>JSON.stringify({i:String(i)})).join(',')+']');const source=await api.openTaskJson(file);let n=0;try{for await(const v of source.value.elements()){expect((await collect(v)).i).toBe(String(n++));}expect(n).toBe(10000);}finally{await source.close();}
 for(const bad of ['{"x":1,}','[true false]','{"x":"unterminated}','{} {}','"'+ 'x'.repeat(393217)+'"']){await writeFile(file,bad);await expect(api.openTaskJson(file)).rejects.toThrow();}
});
