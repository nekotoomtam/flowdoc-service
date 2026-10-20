import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
it('frames versioned feedback and preflights PDF integrity before its binary part',async()=>{
 const {taskWire}=await import('../dist/tasks/wire.js');const chunks=[];let type,ended=false;
 const response={start:t=>{type=t;},write:async b=>{chunks.push(Buffer.from(b));},end:async()=>{ended=true;},abort:async()=>{}};
 const wire=taskWire(response,'10000000-0000-4000-8000-000000000001');
 await wire.event('task','validating',{createdAt:'2026-10-19T00:00:00Z',expiresAt:'2026-10-19T03:00:00Z',template:{docKey:'test',version:1,fingerprint:'a'.repeat(64)}},3);
 const pdf=Buffer.from('%PDF-1.7\nraw\0binary\r\n%%EOF'),dir=await mkdtemp(join(tmpdir(),'task-wire-')),path=join(dir,'pdf');await writeFile(path,pdf);
 const meta={bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),pageCount:1,completeness:'complete'};
 await wire.pdf(path,meta,new AbortController().signal);expect(ended).toBe(true);expect(type).toMatch(/flowdoc=task-v1/);
 const all=Buffer.concat(chunks).toString('latin1');expect(all).toContain('"version":1,"seq":1,"type":"task"');expect(all).toContain('"type":"artifact"');expect(all).not.toContain('jobId');expect(all).toContain(pdf.toString('latin1'));
});
it('rejects a corrupt artifact before PDF headers and closes an error envelope',async()=>{
 const {taskWire}=await import('../dist/tasks/wire.js');const chunks=[];let ended=false;const out={start(){},write:async b=>chunks.push(Buffer.from(b)),end:async()=>{ended=true;},abort:async()=>{}};
 const wire=taskWire(out,'10000000-0000-4000-8000-000000000001'),dir=await mkdtemp(join(tmpdir(),'task-wire-')),path=join(dir,'pdf');await writeFile(path,'bad');
 await expect(wire.pdf(path,{bytes:3,sha256:'a'.repeat(64),pageCount:1,completeness:'complete'},new AbortController().signal)).rejects.toMatchObject({code:'STORAGE_IO'});
 await wire.error('STORAGE_IO','sending','failed');expect(ended).toBe(true);const all=Buffer.concat(chunks).toString();expect(all).toContain('"type":"error"');expect(all).not.toContain('Content-Type: application/pdf');
});
