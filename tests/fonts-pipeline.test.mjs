import {beforeAll,afterAll,it,expect} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createAuthoring} from '../dist/authoring/service.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {stageFont} from './fontFixture.mjs';
import {createUploads} from '../dist/uploads/service.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {Readable} from 'node:stream';
const db=isolatedDatabase(),pool=db.pool,ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let root,api,seed,sample;
beforeAll(async()=>{await db.setup();ok(await migrate(pool));root=await mkdtemp(join(tmpdir(),'font-pipeline-'));process.env.FONT_STORAGE_DIR=root;api=createAuthoring(pool,'owner',{maxOutstanding:10,imagesEnabled:false});seed=JSON.parse(await readFile('examples/area-document-template.json','utf8'));sample=JSON.parse(await readFile('examples/area-document-request.json','utf8'));});
afterAll(async()=>{delete process.env.FONT_STORAGE_DIR;await db.close();await rm(root,{recursive:true,force:true});});
async function ready(){const font=await stageFont(pool,root,process.env.FONT_FIXTURE_DIR?join(process.env.FONT_FIXTURE_DIR,'Pridi','Pridi-Regular.ttf'):'Sarabun-Regular.ttf');await pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[font.id]);const def={...structuredClone(seed),templateId:randomUUID(),docKey:'pipeline-'+randomUUID(),schemaVersion:2};for(const [k,s] of Object.entries(def.styles))def.styles[k]={font:font.fontSelection,fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};return {font,def,request:{...structuredClone(sample),docKey:def.docKey}};}
async function processOne(id){let bytes;const processor=await startProcessor({pool,policy:{retain:true,ttlHours:24,tempHours:24},pollMs:10,files:{writePdf:async(job,b)=>{bytes=b;return {path:job+'.pdf',byteSize:b.length};}}});try{for(let i=0;i<600;i++){const r=(await pool.query('SELECT status,errors_json FROM generation_jobs WHERE id=$1',[id])).rows[0];if(['succeeded','failed'].includes(r.status))return {...r,bytes};await new Promise(r=>setTimeout(r,20));}throw Error('processor timeout');}finally{await processor.stop();}}
it('persists admission fonts with the job, survives retirement and restart, and keeps font errors from the child',async()=>{
 const {font,def,request}=await ready();ok(await registerTemplate(pool,JSON.stringify(def)));
 const job=ok(await submitJob(pool,request)),row=(await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[job.jobId])).rows[0];expect(row.snapshot).toMatchObject({version:1,rendererIdentity:{version:'0.4.1-dev.font-height.1'},bindings:[expect.objectContaining({releaseId:font.id,sha256:font.sha256})]});
 await pool.query("UPDATE font_releases SET state='retired' WHERE id=$1",[font.id]);
 const result=await processOne(job.jobId);expect(result.status,JSON.stringify(result.errors_json)).toBe('succeeded');expect(Buffer.from(result.bytes).subarray(0,5).toString()).toBe('%PDF-');
 if(process.env.FONT_PROOF_DIR)await writeFile(join(process.env.FONT_PROOF_DIR,'pinned-library.pdf'),result.bytes);
 const next=ok(await submitJob(pool,request));await writeFile(join(root,'assets',font.sha256+'.bin'),Buffer.from('changed after admission'));
 const broken=await processOne(next.jobId);expect(broken).toMatchObject({status:'failed',errors_json:[{code:'FONT_ASSET_HASH_MISMATCH'}]});
 expect(broken.bytes).toBeUndefined();await writeFile(join(root,'assets',font.sha256+'.bin'),font.font);
},60000);
it('replays the original upload job and snapshot even when the font file later disappears',async()=>{
 const {font,def,request}=await ready();ok(await registerTemplate(pool,JSON.stringify(def)));
 const uploads=createUploads({pool,files:await createResourceFiles(join(root,'uploads')),config:readUploadConfig({})});
 try{
  const upload=await uploads.create({requestKey:randomUUID(),items:[{key:'unused',source:'upload',mediaType:'image/png',byteSize:3}]});await uploads.receive(upload.uploadId,upload.items[0].resourceId,Readable.from([Buffer.from('abc')]));await uploads.finalize(upload.uploadId);
  request.uploadId=upload.uploadId;const job=ok(await submitJob(pool,request,true));const pinned=(await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[job.jobId])).rows[0];
  await rm(join(root,'assets',font.sha256+'.bin'));
  try{expect(ok(await submitJob(pool,request,true)).jobId).toBe(job.jobId);expect((await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[job.jobId])).rows[0]).toEqual(pinned);expect(await processOne(job.jobId)).toMatchObject({status:'failed',errors_json:[{code:'FONT_ASSET_UNAVAILABLE'}]});}finally{await writeFile(join(root,'assets',font.sha256+'.bin'),font.font);}
 }finally{await uploads.stop();}
},60000);
it('checks actual variable text at admission and refuses missing glyphs without enqueueing',async()=>{
 const {font,def,request}=await ready();const id=ok(await api.create({name:'Actual',docKey:def.docKey,idempotencyKey:randomUUID()}));def.templateId=id.templateId;
 const saved=ok(await api.save(id.templateId,{definition:def,expectedRevision:0,idempotencyKey:'save'}));expect(saved.fontReadiness).toMatchObject({status:'ready',checkedScope:'styles'});
 expect(ok(await api.validate({definition:def,sampleRequest:request})).fontReadiness.status).toBe('ready');
 // Add an actual unsupported code point to a bound string, preserving the request's grammar.
 const replace=v=>{for(const [k,x] of Object.entries(v)){if(typeof x==='string'&&k!=='format'&&k!=='docKey'){v[k]='🦄';return true;}if(x&&typeof x==='object'&&replace(x))return true;}return false;};expect(replace(request.sections)).toBe(true);
 const checked=ok(await api.validate({definition:def,sampleRequest:request}));expect(checked.fontReadiness).toMatchObject({status:'blocked',checkedScope:'actual_input',issues:[{code:'FONT_GLYPH_MISSING'}]});
 const before=(await pool.query('SELECT count(*) FROM generation_jobs')).rows;
 expect(await api.preview(id.templateId,{expectedRevision:1,sampleRequest:request,idempotencyKey:'bad-glyph'})).toMatchObject({ok:false,issues:[{code:'FONT_GLYPH_MISSING'}]});
 expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows).toEqual(before);
},60000);
