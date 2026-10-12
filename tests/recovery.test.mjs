import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
import {getJob} from '../dist/jobs/repository.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {renderPinnedJob,cleanupRenderTemps} from '../dist/jobs/render.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),pool=db.pool,input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
const policy={retain:false,ttlHours:24,tempHours:24};let root,files,resources,uploads,now=Date.now();
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
async function until(fn){for(let i=0;i<1000;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,20));}throw Error('Recovery condition timed out');}
beforeAll(async()=>{await db.setup();ok(await migrate(pool));ok(await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8')));root=await mkdtemp(join(tmpdir(),'recovery-'));files=await createPdfFiles(join(root,'pdf'));resources=await createResourceFiles(join(root,'resources'));uploads=createUploads({pool,files:resources,config:readUploadConfig({}),clock:()=>now});});
afterAll(async()=>{await uploads?.stop();await db.close();if(root)await rm(root,{recursive:true,force:true});});
async function uploadJob(){const s=await uploads.create({requestKey:randomUUID(),items:[{key:'source',source:'upload',mediaType:'image/png',byteSize:3}]});await uploads.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]));await uploads.finalize(s.uploadId);return {uploadId:s.uploadId,job:ok(await submitJob(pool,{...input,uploadId:s.uploadId},true))};}
it('recovers a killed processor without rerunning its interrupted job or losing queued uploads',async()=>{
 const first=await uploadJob(),next=await uploadJob();
 const child=fork(new URL('./fixtures/recovery-worker.mjs',import.meta.url),[],{env:{...process.env,TEST_DB_OPTIONS:pool.options.options},stdio:['ignore','ignore','ignore','ipc']});
 let processor;
 try{
  await Promise.race([once(child,'message'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Worker did not start')),10000);t.unref();})]);
  expect(ok(await getJob(pool,first.job.jobId)).status).toBe('running');expect(ok(await getJob(pool,next.job.jobId)).status).toBe('queued');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  now+=7200000;await uploads.cleanup();
  const keys=(await pool.query('SELECT storage_key FROM upload_items WHERE upload_id=ANY($1::uuid[])',[[first.uploadId,next.uploadId]])).rows;
  for(const item of keys)expect(await resources.exists(item.storage_key,3)).toBe(true);
  processor=await startProcessor({pool,files,policy,initialize:()=>uploads.recover(),pollMs:10});
  await until(async()=>ok(await getJob(pool,next.job.jobId)).status==='succeeded');
  expect(ok(await getJob(pool,first.job.jobId))).toMatchObject({status:'failed',errors:[{code:'PROCESS_INTERRUPTED'}],processing:{stage:'failed'}});
  expect((await pool.query('SELECT job_id FROM document_outputs WHERE job_id=ANY($1::uuid[])',[[first.job.jobId,next.job.jobId]])).rows.map(r=>r.job_id)).toEqual([next.job.jobId]);
  for(const item of keys)expect(await resources.exists(item.storage_key,3)).toBe(true);
  expect(processor.isReady()).toBe(true);
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await processor?.stop();}
},30000);
it('a real renderer timeout fails only that job and cleans temporary output before the next succeeds',async()=>{
 const first=ok(await submitJob(pool,input)),next=ok(await submitJob(pool,input)),temp=join(root,'render');let count=0;
 const processor=await startProcessor({pool,files,policy,initialize:()=>cleanupRenderTemps(temp),render:(p,t,s,images)=>renderPinnedJob(p,t,s,++count===1?1:120000,52428800,temp,images),pollMs:10});
 try{await until(async()=>ok(await getJob(pool,next.jobId)).status==='succeeded');expect(ok(await getJob(pool,first.jobId))).toMatchObject({status:'failed',errors:[{code:'RENDER_FAILED'}]});expect((await pool.query('SELECT id FROM document_outputs WHERE job_id=$1',[first.jobId])).rowCount).toBe(0);expect(await readdir(temp)).toEqual([]);expect(count).toBe(2);}finally{await processor.stop();}
},30000);
it('actual coordinator connection loss closes admission and health without consuming a slot',async()=>{
 let lockPid;
 const wrapped={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();lockPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return c;}};
 const processor=await startProcessor({pool:wrapped,files,policy,pollMs:10});
 const app=createServer({pool,outputs:{available:async()=>false},isReady:()=>processor.isReady()});
 try{
  await pool.query('SELECT pg_terminate_backend($1)',[lockPid]);await until(()=>!processor.isReady());
  const before=(await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
  expect((await app.inject('/health')).statusCode).toBe(503);
  const response=await app.inject({method:'POST',url:'/jobs',payload:input});expect(response.statusCode).toBe(503);expect(response.json().issues[0].code).toBe('UNAVAILABLE');
  expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(before);
 }finally{await app.close();await processor.stop();}
},30000);
