import {createUploads} from '../dist/uploads/service.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {renderPinnedJob} from '../dist/jobs/render.js';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),pool=db.pool;let app,other,id,definition,jobId,root,files,outputs,uploads;
const token='a'.repeat(40),headers={authorization:'Bearer '+token};
const seed=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));
const sample=JSON.parse(readFileSync('examples/area-document-request.json','utf8'));
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'authoring-'));files=await createPdfFiles(root);outputs=createOutputs(pool,files,24);uploads=createUploads({pool,files:await createResourceFiles(join(root,'resources')),config:readUploadConfig({})});app=createServer({pool,isReady:()=>true,outputs,uploads,imagesEnabled:true,authoring:{token,principal:'owner-a'}});other=createServer({pool,isReady:()=>true,outputs:{},uploads,imagesEnabled:true,authoring:{token,principal:'owner-b'}});});
afterAll(async()=>{await app?.close();await other?.close();await db.close();if(root)await rm(root,{recursive:true,force:true});});
const call=(method,url,payload,server=app)=>server.inject({method,url,headers,...(payload?{payload}:{})});
it('creates a server ID before accepting a definition; no dummy current/version',async()=>{
 expect((await app.inject('/authoring/contract')).statusCode).toBe(401);
 const r=await call('POST','/authoring/drafts',{name:'Authoring example',docKey:'authoring-example',idempotencyKey:'create-1'});
 expect(r.statusCode,r.body).toBe(201);id=r.json().value.templateId;expect(id).toMatch(/^[0-9a-f-]{36}$/);expect(r.json().value).toMatchObject({revision:0,state:'empty',definition:null});
 const retry=await call('POST','/authoring/drafts',{name:'Authoring example',docKey:'authoring-example',idempotencyKey:'create-1'});expect(retry.json().value.templateId).toBe(id);
 expect((await call('POST','/authoring/drafts',{name:'Different',docKey:'authoring-example',idempotencyKey:'create-1'})).statusCode).toBe(409);
 expect((await call('GET','/authoring/drafts/'+id,undefined,other)).statusCode).toBe(404);
 expect((await pool.query('SELECT count(*) FROM template_current')).rows[0].count).toBe('0');
 expect((await call('POST',`/authoring/drafts/${id}/previews`,{expectedRevision:0,sampleRequest:{},idempotencyKey:'empty'})).statusCode).toBe(422);
});
it('saves schemas separately, preserves IDs, rejects stale or invalid update',async()=>{
 definition={...seed,templateId:id,docKey:'authoring-example'};
 const first=await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:0,definition,idempotencyKey:'save-1'});expect(first.statusCode,first.body).toBe(200);expect(first.json().value.revision).toBe(1);
 const ids=(await pool.query('SELECT id FROM variables ORDER BY id')).rows;
 const invalid=structuredClone(definition);invalid.areaFormats.meeting.ownerAreaId='missing';
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition:invalid,idempotencyKey:'invalid'})).statusCode).toBe(422);
 definition.name='Updated';const update=await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition,idempotencyKey:'save-2'});expect(update.statusCode,update.body).toBe(200);expect(update.json().value.revision).toBe(2);
 expect((await pool.query('SELECT id FROM variables ORDER BY id')).rows).toEqual(ids);
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition,idempotencyKey:'save-2'})).json().value.revision).toBe(2);
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition,idempotencyKey:'stale'})).statusCode).toBe(409);
});
it('pins preview revision without publication and hides it from public job endpoints',async()=>{
 const input={expectedRevision:2,sampleRequest:{...sample,docKey:'authoring-example'},idempotencyKey:'preview-1'};
 const r=await call('POST',`/authoring/drafts/${id}/previews`,input);expect(r.statusCode,r.body).toBe(202);jobId=r.json().value.jobId;
 expect((await call('POST',`/authoring/drafts/${id}/previews`,input)).json().value.jobId).toBe(jobId);
 expect((await pool.query('SELECT count(*) FROM template_versions')).rows[0].count).toBe('0');
 expect((await app.inject('/jobs/'+jobId)).statusCode).toBe(404);expect((await app.inject('/jobs/'+jobId+'/pdf')).statusCode).toBe(404);
 expect((await call('GET','/authoring/previews/'+jobId,undefined,other)).statusCode).toBe(404);
 definition.name='After preview';expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:2,definition,idempotencyKey:'save-3'})).statusCode).toBe(200);
 const status=await call('GET','/authoring/previews/'+jobId);expect(status.json().value).toMatchObject({revision:2,status:'queued'});
 const pinned=(await pool.query('SELECT preview_definition FROM generation_jobs WHERE id=$1',[jobId])).rows[0].preview_definition;expect(pinned.name).toBe('Updated');
 expect((await call('POST',`/authoring/drafts/${id}/publish`,{})).statusCode).toBe(404);
});

it('renders pinned preview identically to direct rendering, permits repeat downloads, and expires output',async()=>{
 const row=(await pool.query('SELECT prepared_input,preview_definition FROM generation_jobs WHERE id=$1',[jobId])).rows[0];
 const direct=await renderPinnedJob(row.prepared_input,row.preview_definition);expect(direct.ok,JSON.stringify(direct)).toBe(true);
 const processor=await startProcessor({pool,files,policy:{retain:false,ttlHours:24,tempHours:24},pollMs:10});
 try{
  let status;for(let n=0;n<500;n++){status=(await call('GET','/authoring/previews/'+jobId)).json().value;if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}
  expect(status).toMatchObject({status:'succeeded',revision:2,outputAvailable:true});
  const one=await call('GET','/authoring/previews/'+jobId+'/pdf'),two=await call('GET','/authoring/previews/'+jobId+'/pdf');
  expect(one.statusCode).toBe(200);expect(two.statusCode).toBe(200);expect(one.rawPayload.equals(two.rawPayload)).toBe(true);
  expect(one.rawPayload.equals(Buffer.from(direct.value.bytes))).toBe(true);
  await pool.query("UPDATE document_outputs SET expires_at=now()-interval '1 second' WHERE job_id=$1",[jobId]);await outputs.cleanup();
  expect((await call('GET','/authoring/previews/'+jobId+'/pdf')).statusCode).toBe(410);
  expect((await call('GET','/authoring/previews/'+jobId)).json().value.outputAvailable).toBe(false);
 }finally{await processor.stop();}
},30000);
it('allows only one concurrent writer at the same revision',async()=>{
 const results=await Promise.all(['a','b'].map(key=>call('PUT','/authoring/drafts/'+id,{expectedRevision:3,definition:{...definition,name:key},idempotencyKey:'concurrent-'+key})));
 expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
});

it('validates without writes and rejects malformed or oversized HTTP inputs',async()=>{
 const before=(await pool.query('SELECT count(*) FROM authoring_audit')).rows;
 const good=await call('POST','/authoring/validate',{definition,sampleRequest:{...sample,docKey:'authoring-example'}});expect(good.statusCode,good.body).toBe(200);
 expect((await pool.query('SELECT count(*) FROM authoring_audit')).rows).toEqual(before);
 expect((await call('POST','/authoring/validate',{definition,unexpected:true})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:'/authoring/validate',headers:{...headers,'content-type':'application/json'},payload:'{"definition":{},"definition":{}}'})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/authoring/validate',headers:{...headers,'content-type':'application/json'},payload:'{"__proto__":{}}'})).statusCode).toBe(400);
 expect((await call('POST','/authoring/validate',{definition,padding:'x'.repeat(2097152)})).statusCode).toBe(413);
});
it('binds uploads atomically to principal, prevents public/cross-owner access, and rejects expired preview resources',async()=>{
 const manifest={requestKey:'image-one',items:[{key:'image',source:'upload',mediaType:'image/png',byteSize:3}]};
 const created=await call('POST','/authoring/uploads',manifest);expect(created.statusCode,created.body).toBe(201);const u=created.json().value;
 expect((await call('POST','/authoring/uploads',manifest)).json().value.uploadId).toBe(u.uploadId);
 expect((await pool.query('SELECT authoring_principal FROM upload_sessions WHERE id=$1',[u.uploadId])).rows[0].authoring_principal).toBe('owner-a');
 expect((await app.inject('/uploads/'+u.uploadId)).statusCode).toBe(404);
 expect((await call('GET','/authoring/uploads/'+u.uploadId,undefined,other)).statusCode).toBe(404);
 expect((await call('PUT','/authoring/uploads/'+u.uploadId+'/items/'+u.items[0].resourceId+'/base64',{data:'YWJj'})).statusCode).toBe(200);
 expect((await call('POST','/authoring/uploads/'+u.uploadId+'/finalize')).statusCode).toBe(200);
 const r=await call('POST','/authoring/drafts/'+id+'/previews',{expectedRevision:4,sampleRequest:{...sample,docKey:'authoring-example',uploadId:u.uploadId},idempotencyKey:'owned-upload'});expect(r.statusCode,r.body).toBe(202);
 const foreign=await call('POST','/authoring/uploads',{...manifest,requestKey:'other'},other);
 expect((await call('POST','/authoring/drafts/'+id+'/previews',{expectedRevision:4,sampleRequest:{...sample,docKey:'authoring-example',uploadId:foreign.json().value.uploadId},idempotencyKey:'foreign'})).statusCode).toBe(404);
 const fresh=(await call('POST','/authoring/uploads',{...manifest,requestKey:'expired'})).json().value;
 await pool.query("UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",[fresh.uploadId]);
 expect((await call('POST','/authoring/drafts/'+id+'/previews',{expectedRevision:4,sampleRequest:{...sample,docKey:'authoring-example',uploadId:fresh.uploadId},idempotencyKey:'expired'})).statusCode).toBe(410);
 expect((await pool.query('SELECT count(*) FROM template_versions')).rows[0].count).toBe('0');
});
