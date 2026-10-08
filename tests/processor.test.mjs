import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
import {getJob} from '../dist/jobs/repository.js';
const api=await import('../dist/jobs/processor.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;const unwrap=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
beforeAll(async()=>{await db.setup();unwrap(await migrate(pool));unwrap(await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8')));});afterAll(()=>db.close());
it('processes serially, keeps status responsive, survives render error, rejects a second coordinator',async()=>{
 expect(api.startProcessor).toBeTypeOf('function');
 const receipts=[];for(let i=0;i<3;i++)receipts.push(unwrap(await submitJob(pool,input)));
 let active=0,max=0,count=0;const writes=[];
 const processor=await api.startProcessor({pool,policy:{retain:false,ttlHours:24,tempHours:24},files:{writePdf:async(id,bytes)=>{writes.push(id);return {path:id+'.pdf',byteSize:bytes.length};}},render:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,60));active--;if(++count===2)throw Error('private child failure');return {ok:true,value:{bytes:Buffer.from('%PDF'),mediaType:'application/pdf',pageCount:1},warnings:[]};},pollMs:10});
 try{
  await expect(api.startProcessor({pool})).rejects.toThrow();
  for(let i=0;i<200;i++){const view=unwrap(await getJob(pool,receipts[2].jobId));if(view.status==='succeeded')break;await new Promise(r=>setTimeout(r,10));}
  expect(max).toBe(1);expect(count).toBe(3);expect(writes).toEqual([receipts[0].jobId,receipts[2].jobId]);
  expect(unwrap(await getJob(pool,receipts[1].jobId))).toMatchObject({status:'failed',errors:[{code:'RENDER_FAILED'}]});
  expect(unwrap(await getJob(pool,receipts[2].jobId)).status).toBe('succeeded');
 }finally{await processor.stop();}
});
it('storage and metadata failures fail the job without publishing partial output',async()=>{
 for(const kind of ['write','metadata']){
  const receipt=unwrap(await submitJob(pool,input));
  if(kind==='metadata')await pool.query("ALTER TABLE document_outputs ADD CONSTRAINT r4_reject CHECK (byte_size<>17)");
  const processor=await api.startProcessor({pool,policy:{retain:false,ttlHours:24,tempHours:24},files:{writePdf:async id=>{if(kind==='write')throw Error('disk path secret');return {path:id+'.pdf',byteSize:17};}},render:async()=>({ok:true,value:{bytes:Buffer.from('%PDF'),mediaType:'application/pdf',pageCount:1},warnings:[]}),pollMs:5});
  try{let view;for(let n=0;n<100;n++){view=unwrap(await getJob(pool,receipt.jobId));if(view.status==='failed')break;await new Promise(r=>setTimeout(r,10));}expect(view.status).toBe('failed');expect((await pool.query('SELECT 1 FROM document_outputs WHERE job_id=$1',[receipt.jobId])).rowCount).toBe(0);}
  finally{await processor.stop();if(kind==='metadata')await pool.query('ALTER TABLE document_outputs DROP CONSTRAINT r4_reject');}
 }
});
it('uncertain commit does not overwrite a successful job; lost lock stops readiness',async()=>{
 const receipt=unwrap(await submitJob(pool,input));let ambiguous=true,lock;
 const wrapped={query:(...args)=>pool.query(...args),connect:async()=>{const client=await pool.connect();if(!lock)lock=client;return new Proxy(client,{get(target,key){if(key==='query')return async(...args)=>{const result=await target.query(...args);if(args[0]==='COMMIT'&&ambiguous){ambiguous=false;throw Error('ack lost after commit');}return result;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
 const processor=await api.startProcessor({pool:wrapped,files:{writePdf:async id=>({path:id+'.pdf',byteSize:4})},policy:{retain:false,ttlHours:24,tempHours:24},render:async()=>({ok:true,value:{bytes:Buffer.from('%PDF'),mediaType:'application/pdf'},warnings:[]}),pollMs:5});
 try{let view;for(let n=0;n<100;n++){view=unwrap(await getJob(pool,receipt.jobId));if(view.status==='succeeded')break;await new Promise(r=>setTimeout(r,10));}expect(view.status).toBe('succeeded');expect((await pool.query('SELECT 1 FROM document_outputs WHERE job_id=$1',[receipt.jobId])).rowCount).toBe(1);lock.emit('error',Error('connection lost'));expect(processor.isReady()).toBe(false);}
 finally{await processor.stop();}
});
