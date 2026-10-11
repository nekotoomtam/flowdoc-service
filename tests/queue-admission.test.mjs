import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
import {createServer} from '../dist/http/server.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
const config=await import('../dist/jobs/config.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool,input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
let uploads,app;
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(pool));ok(await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8')));uploads=createUploads({pool,files:await createResourceFiles(await mkdtemp(join(tmpdir(),'queue-'))),config:readUploadConfig({})});});
beforeEach(async()=>{await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now() WHERE status IN ('queued','running')");});
afterAll(async()=>{await app?.close();await uploads?.stop();await db.close();});
async function uploaded(){const s=await uploads.create({requestKey:randomUUID(),items:[{key:'image',source:'upload',mediaType:'image/png',byteSize:3}]});await uploads.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]));await uploads.finalize(s.uploadId);return {...input,uploadId:s.uploadId};}
it('defaults to ten and rejects invalid capacity configuration',()=>{
 expect(config.readJobConfig).toBeTypeOf('function');
 expect(config.readJobConfig({})).toEqual({maxOutstanding:10});
 expect(config.readJobConfig({JOB_MAX_OUTSTANDING:'3'})).toEqual({maxOutstanding:3});
 for(const value of ['', '0','-1','1.5','NaN','Infinity','9007199254740992'])expect(()=>config.readJobConfig({JOB_MAX_OUTSTANDING:value})).toThrow();
 expect(()=>createServer({pool,outputs:{},isReady:()=>true,maxOutstanding:0})).toThrow();
});
it('enforces the default ten-job cap through HTTP without a processor',async()=>{
 await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now() WHERE status IN ('queued','running')");
 const server=createServer({pool,outputs:{available:async()=>false},isReady:()=>true});
 try{
  const results=await Promise.all(Array.from({length:11},()=>server.inject({method:'POST',url:'/jobs',payload:input})));
  expect(results.filter(r=>r.statusCode===202)).toHaveLength(10);
  expect(results.filter(r=>r.statusCode===503)).toHaveLength(1);
  expect(results.find(r=>r.statusCode===503).json().issues[0].code).toBe('QUEUE_FULL');
 }finally{await server.close();}
});
it('atomically caps mixed admission, preserves rejected uploads, replays claims and frees terminal slots',async()=>{
 const existing=await uploaded(),first=ok(await submitJob(pool,existing,true,3));
 await pool.query("UPDATE generation_jobs SET status='running' WHERE id=$1",[first.jobId]);
 const requests=[await uploaded(),await uploaded(),await uploaded()];
 const candidates=[requests[0],input,requests[1],input,requests[2],input];
 const results=await Promise.all(candidates.map(body=>submitJob(pool,body,true,3)));
 expect(results.filter(r=>r.ok)).toHaveLength(2);
 expect(results.filter(r=>!r.ok).every(r=>r.issues[0].code==='QUEUE_FULL')).toBe(true);
 expect(Number((await pool.query("SELECT count(*) FROM generation_jobs WHERE status IN ('queued','running')")).rows[0].count)).toBe(3);
 expect(ok(await submitJob(pool,existing,true,3)).jobId).toBe(first.jobId);
 expect((await submitJob(pool,{...existing,data:{...existing.data,projectName:'changed'}},true,3)).issues[0].code).toBe('UPLOAD_CONFLICT');
 const rejected=await uploaded();
 app=createServer({pool,outputs:{available:async()=>false},isReady:()=>true,imagesEnabled:true,maxOutstanding:3});
 const response=await app.inject({method:'POST',url:'/jobs',payload:rejected});
 expect(response.statusCode).toBe(503);expect(response.json()).toMatchObject({ok:false,issues:[{code:'QUEUE_FULL'}]});expect(response.json()).not.toHaveProperty('value');
 expect((await pool.query('SELECT * FROM upload_job_claims WHERE upload_id=$1',[rejected.uploadId])).rowCount).toBe(0);
 expect((await uploads.get(rejected.uploadId)).status).toBe('ready');
 await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now() WHERE id=$1",[first.jobId]);
 const retry=await app.inject({method:'POST',url:'/jobs',payload:rejected});expect(retry.statusCode).toBe(202);
 await pool.query("UPDATE generation_jobs SET status='succeeded',finished_at=now() WHERE id=$1",[retry.json().value.jobId]);
 expect((await app.inject({method:'POST',url:'/jobs',payload:input})).statusCode).toBe(202);
});

