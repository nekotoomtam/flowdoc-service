import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {prepareGeneration} from '@flowdoc/core';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {failInterruptedJobs} from '../dist/jobs/repository.js';
const api=await import('../dist/uploads/claims.js').catch(()=>({}));
const db=isolatedDatabase();let u,files,base,time=Date.now();
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));files=await createResourceFiles(await mkdtemp(join(tmpdir(),'claim-')));u=createUploads({pool:db.pool,files,config:readUploadConfig({}),clock:()=>time});
 ok(await registerTemplate(db.pool,readFileSync('examples/srs-template.json','utf8')));
 const originalInput=JSON.parse(readFileSync('examples/srs-request.json','utf8')),loaded=ok(await loadTemplate(db.pool,originalInput.docKey));
 base={versionId:loaded.versionId,originalInput,preparedInput:ok(prepareGeneration(loaded.template,originalInput))};});
afterAll(async()=>{await u?.stop();await db.close();});
async function set(ready=true){const s=await u.create({requestKey:randomUUID(),items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:3}]});await u.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]));if(ready)await u.finalize(s.uploadId);return {...base,uploadId:s.uploadId,resourceIds:[s.items[0].resourceId]};}
const claim=args=>api.enqueueWithUpload(db.pool,args,time);
it('serializes identical claims, rejects changed input and keeps one job',async()=>{
 expect(api.enqueueWithUpload).toBeTypeOf('function');const args=await set();
 const before=Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count);
 const results=await Promise.all([claim(args),claim(args)]);expect(results[0].jobId).toBe(results[1].jobId);expect(results.filter(r=>r.created)).toHaveLength(1);
 await expect(claim({...args,originalInput:{...args.originalInput,changed:true}})).rejects.toMatchObject({code:'UPLOAD_CONFLICT'});
 await expect(claim({...args,versionId:randomUUID()})).rejects.toMatchObject({code:'UPLOAD_CONFLICT'});
 expect(Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count)).toBe(before+1);
});
it('rejects open, expired, wrong-set and missing resources without a job',async()=>{
 const open=await set(false);await expect(claim(open)).rejects.toMatchObject({code:'UPLOAD_INCOMPLETE'});
 const a=await set(),b=await set();await expect(claim({...a,resourceIds:b.resourceIds})).rejects.toMatchObject({code:'INVALID_RESOURCE'});
 await expect(claim({...a,resourceIds:[randomUUID()]})).rejects.toMatchObject({code:'INVALID_RESOURCE'});
 await db.pool.query('UPDATE upload_sessions SET expires_at=$2 WHERE id=$1',[a.uploadId,new Date(time-1)]);await expect(claim(a)).rejects.toMatchObject({code:'UPLOAD_GONE'});
 expect((await db.pool.query('SELECT * FROM upload_job_claims WHERE upload_id=ANY($1::uuid[])',[[open.uploadId,a.uploadId,b.uploadId]])).rows).toHaveLength(0);
});
it('rolls back insertion failure so a valid retry can claim the set',async()=>{
 const a=await set();await expect(claim({...a,versionId:randomUUID()})).rejects.toThrow();
 expect((await db.pool.query('SELECT * FROM upload_job_claims WHERE upload_id=$1',[a.uploadId])).rows).toHaveLength(0);expect((await claim(a)).created).toBe(true);
});
it('pins queued/running originals across expiry and restart, then cleans one hour after terminal',async()=>{
 const a=await set(),job=await claim(a);const item=(await db.pool.query('SELECT storage_key FROM upload_items WHERE id=$1',[a.resourceIds[0]])).rows[0];
 time+=7200000;await u.cleanup();await u.recover();expect(await files.exists(item.storage_key,3)).toBe(true);expect((await u.get(a.uploadId)).status).toBe('claimed');
 await db.pool.query("UPDATE generation_jobs SET status='running' WHERE id=$1",[job.jobId]);await u.cleanup();expect(await files.exists(item.storage_key,3)).toBe(true);
 await failInterruptedJobs(db.pool);await db.pool.query('UPDATE generation_jobs SET finished_at=$2 WHERE id=$1',[job.jobId,new Date(time)]);
 time+=3599999;await u.cleanup();expect(await files.exists(item.storage_key,3)).toBe(true);
 expect((await claim(a)).jobId).toBe(job.jobId);
 time+=1;await u.cleanup();expect(await files.exists(item.storage_key,3)).toBe(false);expect((await u.get(a.uploadId)).status).toBe('expired');
 await expect(claim(a)).rejects.toMatchObject({code:'UPLOAD_GONE'});
});
