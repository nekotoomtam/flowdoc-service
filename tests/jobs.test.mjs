import {beforeAll,afterAll,it,expect} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
const api=await import('../dist/jobs/repository.js').catch(()=>({}));
const admission=await import('../dist/jobs/admission.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;
const template=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
const unwrap=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();unwrap(await migrate(pool));template.docKey='jobs-'+randomUUID();template.templateId=template.docKey;template.examples=[];input.docKey=template.docKey;unwrap(await registerTemplate(pool,JSON.stringify(template)));});
afterAll(()=>db.close());
it('rejects invalid input without accepting a job',async()=>{
 expect(admission.submitJob).toBeTypeOf('function');
 const before=(await pool.query('select count(*) from generation_jobs')).rows[0].count;
 expect((await admission.submitJob(pool,{...input,data:{projectName:42}})).ok).toBe(false);
 expect((await admission.submitJob(pool,{...input,content:[{format:'missing',data:{}}]})).ok).toBe(false);
 expect((await pool.query('select count(*) from generation_jobs')).rows[0].count).toBe(before);
});
it('pins input, persists warnings, claims FIFO and prevents terminal overwrite',async()=>{
 expect(admission.submitJob).toBeTypeOf('function');expect(api.claimNextJob).toBeTypeOf('function');
 const request={...input,content:[...input.content,{format:'unknown',data:{}}]};
 const first=unwrap(await admission.submitJob(pool,request));
 const second=unwrap(await admission.submitJob(pool,input));
 unwrap(await registerTemplate(pool,JSON.stringify({...template,version:2})));
 const saved=unwrap(await api.getJob(pool,first.jobId));expect(saved.version).toBe(1);expect(saved.hasWarnings).toBe(true);expect(saved.skippedContentIndices).toEqual([input.content.length]);expect(saved).not.toHaveProperty('prepared_input');
 // Other test fixtures may be queued. Drain claims, retaining the jobs owned here.
 const claimed=[];for(;;){const job=await api.claimNextJob(pool);if(!job)break;claimed.push(job);}
 expect(claimed.findIndex(j=>j.id===first.jobId)).toBeLessThan(claimed.findIndex(j=>j.id===second.jobId));
 const j=claimed.find(j=>j.id===first.jobId);expect(j.preparedInput.template.version).toBe(1);
 expect(await api.failJob(pool,j.id,[{code:'RENDER_FAILED',path:'job',message:'Render failed'}])).toBe(true);
 expect(await api.failJob(pool,j.id,[])).toBe(false);
 await api.failInterruptedJobs(pool);expect(unwrap(await api.getJob(pool,second.jobId))).toMatchObject({status:'failed',errors:[{code:'PROCESS_INTERRUPTED'}]});
 expect(await api.getJob(pool,'bad')).toMatchObject({ok:false,issues:[{code:'INVALID_JOB_ID'}]});
 expect(await api.getJob(pool,randomUUID())).toMatchObject({ok:false,issues:[{code:'JOB_NOT_FOUND'}]});
});

