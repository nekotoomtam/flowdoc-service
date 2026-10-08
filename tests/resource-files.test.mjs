import {it,expect} from 'vitest';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const api=await import('../dist/storage/resource-files.js').catch(()=>({}));
it('streams bounded bytes, verifies length and hash, and removes failed partials',async()=>{
 expect(api.createResourceFiles).toBeTypeOf('function');
 const root=await mkdtemp(join(tmpdir(),'flowdoc-resource-')),files=await api.createResourceFiles(root);
 const bytes=Buffer.alloc(8192,7),name=randomUUID()+'.bin';
 async function* chunks(){for(let n=0;n<8;n++)yield bytes.subarray(n*1024,(n+1)*1024);}
 const r=await files.receive(name,chunks(),8192,new AbortController().signal);
 expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(await readFile(join(root,name))).toEqual(bytes);
 await expect(files.receive(randomUUID()+'.bin',chunks(),8000,new AbortController().signal)).rejects.toThrow();
 await expect(files.receive(randomUUID()+'.bin',chunks(),9000,new AbortController().signal)).rejects.toThrow();
 await expect(files.receive('../escape',chunks(),8192,new AbortController().signal)).rejects.toThrow();
 expect(await readdir(root)).toEqual([name]);
});
it('aborts stalled input without leaving a ready file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flowdoc-abort-')),files=await api.createResourceFiles(root);
 const {PassThrough}=await import('node:stream');const input=new PassThrough(),abort=new AbortController();
 const pending=files.receive(randomUUID()+'.bin',input,100,abort.signal);setTimeout(()=>abort.abort(),10);
 await expect(pending).rejects.toThrow();expect(await readdir(root)).toEqual([]);
});
