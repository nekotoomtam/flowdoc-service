import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
const db=isolatedDatabase(),pool=db.pool,headers={authorization:'Bearer '+'b'.repeat(40)};
let app,root,processor;
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'area-cover-'));const files=await createPdfFiles(root);app=createServer({pool,isReady:()=>true,outputs:createOutputs(pool,files,24),authoring:{token:'b'.repeat(40),principal:'stage2'}});processor=await startProcessor({pool,files,policy:{retain:false,ttlHours:24,tempHours:24},pollMs:10});});
afterAll(async()=>{await processor?.stop();await app?.close();await db.close();if(root)await rm(root,{recursive:true,force:true});});
const call=(method,url,payload)=>app.inject({method,url,headers,...(payload?{payload}:{})});
it('advertises only implemented Area cover capabilities and protects discovery',async()=>{
 expect((await app.inject('/authoring/contract')).statusCode).toBe(401);
 expect((await call('GET','/authoring/contract')).json().value.sectionInstances).toEqual({model:19,input:'array-by-id',assembly:'saved-definition',stage:3,coverArea:true,scopedToc:true});
});
it('saves and processes a pinned single-Section Area cover through the actual packaged Core',async()=>{
 const t=JSON.parse(readFileSync('tests/fixtures/area-cover/template.json')),r=JSON.parse(readFileSync('tests/fixtures/area-cover/request.json'));
 // Image rendering is covered by Core's packed consumer; no external upload in this Service test.
 delete t.areaFormats['format-3'].inputSchema.fields.photo;delete r.sections[0].data.introduction[0].data.photo;
 const intro=t.areaFormats['format-3'].fragment;intro.rootIds=intro.rootIds.filter(id=>id!=='photo');delete intro.nodes.photo;
 const identity=await call('POST','/authoring/drafts',{docKey:t.docKey,name:t.name,idempotencyKey:'create'});expect(identity.statusCode,identity.body).toBe(201);t.templateId=identity.json().value.templateId;
 const id=t.templateId;expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:0,definition:t,idempotencyKey:'save'})).statusCode).toBe(200);
 const ready=await call('POST','/authoring/validate',{definition:t,sampleRequest:r});expect(ready.statusCode,ready.body).toBe(200);
 const queued=await call('POST',`/authoring/drafts/${id}/previews`,{expectedRevision:1,sampleRequest:r,idempotencyKey:'preview'});expect(queued.statusCode,queued.body).toBe(202);const jobId=queued.json().value.jobId;
 const pinned=(await pool.query('SELECT prepared_input,preview_definition FROM generation_jobs WHERE id=$1',[jobId])).rows[0];expect(pinned.prepared_input.schemaVersion).toBe(2);expect(Array.isArray(pinned.prepared_input.sections)).toBe(true);expect(pinned.preview_definition).toEqual(t);
 let status;for(let n=0;n<500;n++){status=(await call('GET','/authoring/previews/'+jobId)).json().value;if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(status,JSON.stringify(status)).toMatchObject({status:'succeeded',revision:1,outputAvailable:true});
 const pdf=await call('GET','/authoring/previews/'+jobId+'/pdf');expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
 const overflow=structuredClone(t);overflow.areaFormats['format-0'].fragment.nodes.heading.props.height.value=1;
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition:overflow,idempotencyKey:'overflow-save'})).statusCode).toBe(200);
 const bad=await call('POST',`/authoring/drafts/${id}/previews`,{expectedRevision:2,sampleRequest:r,idempotencyKey:'overflow-preview'});expect(bad.statusCode,bad.body).toBe(202);const badId=bad.json().value.jobId;
 for(let n=0;n<500;n++){status=(await call('GET','/authoring/previews/'+badId)).json().value;if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(status.status).toBe('failed');expect(JSON.stringify(status)).toContain('LAYOUT_FAILED');
 expect((await call('GET','/authoring/previews/'+jobId+'/pdf')).rawPayload.equals(pdf.rawPayload)).toBe(true);
 expect((await pool.query('SELECT count(*) FROM template_versions')).rows[0].count).toBe('0');
},30000);
