import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
const api=await import('../dist/storage/outputs.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;let files,root;
const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'flowdoc-outputs-'));files=await createPdfFiles(root);});afterAll(()=>db.close());
async function fixture(retain=false){const r=await submitJob(pool,input);expect(r.ok).toBe(true);const id=r.value.jobId;await files.writePdf(id,Buffer.from('%PDF-test'));await pool.query("UPDATE generation_jobs SET status='succeeded' WHERE id=$1",[id]);await pool.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,retain) VALUES(uuidv7(),$1,$2,'application/pdf',9,$3)",[id,id+'.pdf',retain]);return id;}
it('aborts preserve files, successful delivery consumes default outputs, retained files expire',async()=>{
 expect(api.createOutputs).toBeTypeOf('function');const outputs=api.createOutputs(pool,files,24);const id=await fixture();
 const a=await outputs.acquire(id);a.stream.destroy();await a.finish(false);expect(await outputs.available(id)).toBe(true);
 const b=await outputs.acquire(id),c=await outputs.acquire(id);b.stream.destroy();await b.finish(true);expect(await outputs.available(id)).toBe(false);expect(await readFile(join(root,id+'.pdf'))).toBeTruthy();c.stream.destroy();await c.finish(false);await expect(readFile(join(root,id+'.pdf'))).rejects.toThrow();await expect(outputs.acquire(id)).rejects.toMatchObject({code:'OUTPUT_GONE'});
 const retained=await fixture(true);const d=await outputs.acquire(retained);d.stream.destroy();await d.finish(true);expect(await outputs.available(retained)).toBe(true);
 await pool.query("UPDATE document_outputs SET expires_at=now()-interval '1 second' WHERE job_id=$1",[retained]);await outputs.cleanup();expect(await outputs.available(retained)).toBe(false);await expect(readFile(join(root,retained+'.pdf'))).rejects.toThrow();
});
it('retirement survives unlink failure and restart cleanup retries deletion',async()=>{
 expect(api.createOutputs).toBeTypeOf('function');const id=await fixture(),outputs=api.createOutputs(pool,{...files,remove:async()=>{throw Error('disk');}},24);const a=await outputs.acquire(id);a.stream.destroy();await expect(a.finish(true)).rejects.toThrow();expect(await outputs.available(id)).toBe(false);const restarted=api.createOutputs(pool,files,24);await restarted.cleanup();await expect(readFile(join(root,id+'.pdf'))).rejects.toThrow();
});
it('retries consumption after DB failure and restart without exposing the file',async()=>{
 const id=await fixture();let failing=false;
 const flaky={query:async(...args)=>{if(failing&&String(args[0]).includes('SET availability'))throw Error('DB unavailable');return pool.query(...args);}};
 const outputs=api.createOutputs(flaky,files,24),lease=await outputs.acquire(id);lease.stream.destroy();failing=true;
 await expect(lease.finish(true)).rejects.toThrow();
 const restarted=api.createOutputs(pool,files,24);expect(await restarted.available(id)).toBe(false);await restarted.cleanup();await expect(restarted.acquire(id)).rejects.toMatchObject({code:'OUTPUT_GONE'});
});
