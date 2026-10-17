import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {isDeepStrictEqual} from 'node:util';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
const db=isolatedDatabase(),pool=db.pool,headers={authorization:'Bearer '+'b'.repeat(40)};
const fixture=()=>JSON.parse(readFileSync('tests/fixtures/format-sizing/template.json'));
const request=()=>JSON.parse(readFileSync('tests/fixtures/format-sizing/request.json'));
let app,other,root,processor,files;
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'format-sizing-'));files=await createPdfFiles(root);const options={pool,isReady:()=>true,outputs:createOutputs(pool,files,24)};app=createServer({...options,authoring:{token:'b'.repeat(40),principal:'format-owner'}});other=createServer({...options,authoring:{token:'b'.repeat(40),principal:'other'}});});
afterAll(async()=>{await processor?.stop();await app?.close();await other?.close();await db.close();if(root)await rm(root,{recursive:true,force:true});});
const call=(method,url,payload,server=app)=>server.inject({method,url,headers,...(payload?{payload}:{})});
async function save(t){const r=await call('POST','/authoring/drafts',{docKey:t.docKey,name:t.name,idempotencyKey:crypto.randomUUID()});expect(r.statusCode,r.body).toBe(201);t.templateId=r.json().value.templateId;const s=await call('PUT',`/authoring/drafts/${t.templateId}`,{expectedRevision:0,definition:t,idempotencyKey:crypto.randomUUID()});expect(s.statusCode,s.body).toBe(200);return t;}
async function preview(t,q){const r=await call('POST',`/authoring/drafts/${t.templateId}/previews`,{expectedRevision:1,sampleRequest:q,idempotencyKey:crypto.randomUUID()});expect(r.statusCode,r.body).toBe(202);return r.json().value.jobId;}
async function finish(jobId){let status;for(let i=0;i<1000;i++){status=(await call('GET','/authoring/previews/'+jobId)).json().value;if(['succeeded','failed'].includes(status.status))return status;await new Promise(r=>setTimeout(r,20));}throw Error(JSON.stringify(status));}
const start=async()=>processor=await startProcessor({pool,files,policy:{retain:true,ttlHours:24,tempHours:24},pollMs:10});
it('protects discovery and advertises exact Format sizing with no Area sizing',async()=>{
 expect((await app.inject('/authoring/contract')).statusCode).toBe(401);const c=(await call('GET','/authoring/contract')).json().value;
 expect(c.formatSizing).toEqual({version:2,nodeModelVersions:[19],fontSchemaVersions:[1,2],modes:['auto','fixed'],fixedContexts:['section-flow-root'],diagnosticsVersion:1});expect(c).not.toHaveProperty('areaSizing');
});
it('pins the saved sizing and full input, independently of later edits, and retains clone/import ownership',async()=>{
 const t=await save(fixture()),q=request(),id=t.templateId,job=await preview(t,q);
 expect((await call('GET',`/authoring/drafts/${id}`,undefined,other)).statusCode).toBe(404);expect((await call('GET','/authoring/previews/'+job,undefined,other)).statusCode).toBe(404);
 const clone=await call('POST',`/authoring/drafts/${id}/clone`,{sourceRevision:1,name:'Copy',docKey:'format-copy',idempotencyKey:'clone'});expect(clone.statusCode,clone.body).toBe(201);const copied=clone.json().value;
 expect(Object.values(copied.definition.areaFormats)[0].sizing).toEqual(t.areaFormats.panel.sizing);expect(copied.definition.sections[0].id).not.toBe(t.sections[0].id);
 const changed=structuredClone(t);changed.areaFormats.panel.sizing.height.value=1000;
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition:changed,idempotencyKey:'later'})).statusCode).toBe(200);
 expect((await call('PUT',`/authoring/drafts/${id}`,{expectedRevision:1,definition:t,idempotencyKey:'stale'})).statusCode).toBe(409);
 await start();const status=await finish(job);expect(status).toMatchObject({status:'succeeded',hasWarnings:true,revision:1,skippedContentIndices:[]});expect(status.warnings[0]).toMatchObject({code:'FORMAT_CONTENT_OMITTED',formatOmission:{areaEntryIndex:0,pending:[{lineIndex:5}]}});
 const pin=(await pool.query('SELECT original_input,prepared_input,preview_definition FROM generation_jobs WHERE id=$1',[job])).rows[0];expect(pin.original_input).toEqual(q);expect(pin.preview_definition).toEqual(t);expect(pin.prepared_input.skippedContentIndices).toEqual([]);
 const bytes=(await call('GET','/authoring/previews/'+job+'/pdf')).rawPayload;expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
 await processor.stop();await start();expect((await finish(job)).warnings).toEqual(status.warnings);expect((await call('GET','/authoring/previews/'+job+'/pdf')).rawPayload.equals(bytes)).toBe(true);
});
it('keeps omission diagnostics on failed visible references and exposes no partial PDF',async()=>{
 await processor.stop();
 const t=fixture();t.docKey+='-reference';t.areaFormats.panel.sizing.height.value=20;const g=t.areaFormats.panel.fragment;g.rootIds.push('hidden');g.nodes.hidden={id:'hidden',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body',anchorId:'secret'},children:[{id:'hiddenValue',type:'text',text:'HIDDEN'}]};
 t.areaFormats.ref={key:'ref',ownerAreaId:'parts',inputSchema:{type:'object',fields:{}},repeats:[],fragment:{rootIds:['ref'],nodes:{ref:{id:'ref',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'jump',type:'reference',target:'secret',text:'JUMP'}]}}}};
 await save(t);const q=request();q.docKey=t.docKey;q.sections[0].data.parts=[{format:'panel',data:{text:'A'}},{format:'ref',data:{}}];const job=await preview(t,q);const pin=(await pool.query('SELECT original_input,prepared_input,preview_definition,preview_fingerprint FROM generation_jobs WHERE id=$1',[job])).rows[0];const valid=validateTemplate(pin.preview_definition);expect(valid.ok,JSON.stringify(valid)).toBe(true);expect(valid.value.fingerprint).toBe(pin.preview_fingerprint);const prepared=prepareGeneration(valid.value,pin.original_input);expect(prepared.ok,JSON.stringify(prepared)).toBe(true);expect(isDeepStrictEqual(JSON.parse(JSON.stringify(prepared.value)),pin.prepared_input)).toBe(true);const composed=composeDocument(valid.value,pin.prepared_input);expect(composed.ok,JSON.stringify(composed)).toBe(true);await start();const status=await finish(job);
 expect(status,JSON.stringify(status)).toMatchObject({status:'failed',hasWarnings:true,outputAvailable:false});expect(status.errors[0]).toMatchObject({code:'LAYOUT_FAILED',reason:'omitted-destination'});expect(status.warnings[0].code).toBe('FORMAT_CONTENT_OMITTED');
 expect((await call('GET','/authoring/previews/'+job+'/pdf')).statusCode).toBe(409);await processor.stop();await start();expect((await finish(job)).warnings).toEqual(status.warnings);
});
it('pins maximum-height rendering through clone and Section import without losing input or warning identity',async()=>{
 await processor?.stop();
 const t=fixture();t.docKey+='-maximum';t.areaFormats.panel.sizing.height.value=300;
 const page=t.pageLayouts.portrait.page;page.margin.bottom={value:297*72/25.4-20*72/25.4-120,unit:'pt'};
 await save(t);const q=request();q.docKey=t.docKey;q.sections[0].data.parts=[{format:'panel',data:{text:Array.from({length:10},(_,i)=>'LINE '+i).join('\n')}},{format:'panel',data:{text:'HIDDEN'}}];
 const original=structuredClone(q),job=await preview(t,q);
 const cloned=await call('POST',`/authoring/drafts/${t.templateId}/clone`,{sourceRevision:1,name:'Maximum copy',docKey:t.docKey+'-clone',idempotencyKey:crypto.randomUUID()});expect(cloned.statusCode,cloned.body).toBe(201);
 const copy=cloned.json().value,cq=structuredClone(q);cq.docKey=copy.docKey;cq.sections[0].id=copy.definition.sections[0].id;expect(cq.sections[0].id).not.toBe(q.sections[0].id);const cloneJob=await preview(copy.definition,cq);
 const target=(await call('POST','/authoring/drafts',{docKey:t.docKey+'-import',name:'Imported',idempotencyKey:crypto.randomUUID()})).json().value;
 const args={sourceTemplateId:t.templateId,sourceRevision:1,sourceSectionIds:[t.sections[0].id],expectedRevision:0,beforeSectionId:null,idempotencyKey:crypto.randomUUID()};
 expect((await call('POST',`/authoring/drafts/${target.templateId}/sections/import`,args,other)).statusCode).toBe(404);
 const imported=await call('POST',`/authoring/drafts/${target.templateId}/sections/import`,args);expect(imported.statusCode,imported.body).toBe(200);const dest=imported.json().value;
 expect(Object.values(dest.definition.areaFormats)[0].sizing).toEqual(t.areaFormats.panel.sizing);const iq=structuredClone(q);iq.docKey=dest.docKey;iq.sections[0].id=dest.definition.sections[0].id;const importedJob=await preview(dest.definition,iq);
 const changed=structuredClone(t);changed.areaFormats.panel.sizing={mode:'auto'};expect((await call('PUT',`/authoring/drafts/${t.templateId}`,{expectedRevision:1,definition:changed,idempotencyKey:crypto.randomUUID()})).statusCode).toBe(200);
 await start();for(const [id,input,definition] of [[job,q,t],[cloneJob,cq,copy.definition],[importedJob,iq,dest.definition]]){
  const status=await finish(id);expect(status).toMatchObject({status:'succeeded',revision:1,hasWarnings:true,skippedContentIndices:[]});expect(status.warnings).toMatchObject([{code:'FORMAT_CONTENT_OMITTED',sectionId:definition.sections[0].id,formatOmission:{areaEntryIndex:0,pending:[{lineIndex:6}]}},{code:'FORMAT_FRAME_NOT_SHOWN',formatFrameOmission:{areaEntryIndex:1,availableHeightPt:0}}]);
  const pin=(await pool.query('SELECT original_input,preview_definition,prepared_input FROM generation_jobs WHERE id=$1',[id])).rows[0];expect(pin.original_input).toEqual(input);expect(pin.preview_definition).toEqual(definition);expect(pin.prepared_input.skippedContentIndices).toEqual([]);expect((await call('GET','/authoring/previews/'+id,undefined,other)).statusCode).toBe(404);
 }
 expect(q).toEqual(original);await processor.stop();await start();expect((await finish(job)).warnings[0].formatOmission.pending[0].lineIndex).toBe(6);
});
