import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {isolatedDatabase} from './isolatedDatabase.mjs';import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';import {createAuthoringTools} from '../dist/tools/authoring.js';
import {importCurrent} from '../dist/templates/current.js';import {readReferences} from '../dist/fonts/retention.js';
import {stageFont} from './fontFixture.mjs';import {fixture,ok} from './helpers/model20-db.mjs';
const db=isolatedDatabase(),token='m'.repeat(40),headers={authorization:'Bearer '+token};let app,other,root,oldFontRoot;
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));root=await mkdtemp(join(tmpdir(),'m20-authoring-'));oldFontRoot=process.env.FONT_STORAGE_DIR;process.env.FONT_STORAGE_DIR=root;const options={pool:db.pool,isReady:()=>true,outputs:{},imagesEnabled:false};app=createServer({...options,authoring:{token,principal:'m20-owner'}});other=createServer({...options,authoring:{token,principal:'other-owner'}});});
afterAll(async()=>{await app?.close();await other?.close();await db.close();if(oldFontRoot===undefined)delete process.env.FONT_STORAGE_DIR;else process.env.FONT_STORAGE_DIR=oldFontRoot;if(root)await rm(root,{recursive:true,force:true});});
const call=(method,url,payload,server=app)=>server.inject({method,url,headers,...(payload?{payload}:{})});
async function draft(model=20){const created=await call('POST','/authoring/drafts',{name:'Model '+model,docKey:'m20-'+randomUUID(),idempotencyKey:randomUUID()});expect(created.statusCode,created.body).toBe(201);const id=created.json().value,{t,request}=fixture(model,id.docKey);t.templateId=id.templateId;t.name=id.name;return{id,t,request,url:'/authoring/drafts/'+id.templateId};}
const save=(d,revision=0,key=randomUUID(),server=app)=>call('PUT',d.url,{definition:d.t,expectedRevision:revision,idempotencyKey:key},server);
// Direct storage seeding isolates safety guards/preview from the new save allow-list.
async function seeded(change=()=>{}){const d=await draft();change(d);ok(await importCurrent(db.pool,JSON.stringify(d.t)));return d;}
const counts=async id=>(await db.pool.query('SELECT (SELECT count(*) FROM authoring_receipts WHERE target=$1)::int receipts,(SELECT count(*) FROM authoring_audit WHERE template_id=$1)::int audit,(SELECT count(*) FROM generation_jobs WHERE preview_template_id=$1)::int jobs',[id])).rows[0];
it('advertises bounded model20 whole-definition support separately from model19 Section instances',async()=>{
 expect((await app.inject('/authoring/contract')).statusCode).toBe(401);const c=ok((await call('GET','/authoring/contract')).json());expect(c.nodeModelVersions).toEqual([18,19,20]);expect(c.publicationEnabled).toBe(false);
 expect(c.sectionInstances).toMatchObject({model:19,input:'array-by-id',assembly:'saved-definition'});
 expect(c.sectionDefinitions).toEqual({model:20,input:'array-by-section-key',instanceKey:'required-unique-per-request',assembly:'request',reuseDefinitions:true,authoring:'whole-definition',createSection:false,importSections:false,cloneTemplate:false});
 // Do not promote model20 layout support from structural authoring checks alone.
 expect(c.groupLabelSpans.nodeModelVersions).toEqual([19]);expect(c.formatSizing.nodeModelVersions).toEqual([19]);
});
it.each([18,19,20])('saves/gets/validates model%s exactly through authenticated HTTP without implicit conversion',async model=>{
 const d=await draft(model),s=await save(d,0,'first');expect(s.statusCode,s.body).toBe(200);const value=s.json().value;expect(value.definition).toEqual(d.t);expect(value.revision).toBe(1);expect(value.fontReadiness.status).toBe('ready');
 expect((await call('GET',d.url)).json().value.definition).toEqual(d.t);expect((await save(d,0,'first')).json().value).toEqual(value);
 const before=await counts(d.id.templateId),v=await call('POST','/authoring/validate',{definition:d.t});expect(v.statusCode,v.body).toBe(200);expect(v.json().value).toMatchObject({composed:false,fingerprint:ok(validateTemplate(d.t)).fingerprint,fontReadiness:{status:'ready'}});expect(await counts(d.id.templateId)).toEqual(before);
 const converted=fixture(model===20?19:20,d.id.docKey).t;converted.templateId=d.id.templateId;const mismatch=await save({...d,t:converted},1);expect(mismatch.statusCode).toBe(422);expect(mismatch.json().issues[0].code).toBe('VERSION_MISMATCH');
});
it('protects model20 principal, identity, receipts and concurrent revisions without partial writes',async()=>{
 const d=await draft();expect((await save(d)).statusCode).toBe(200);const before=await counts(d.id.templateId);
 expect((await save(d,1,'foreign',other)).statusCode).toBe(404);expect((await call('GET',d.url,undefined,other)).statusCode).toBe(404);
 for(const field of ['templateId','docKey','version']){const forged=structuredClone(d.t);forged[field]=field==='version'?2:'forged';forged.examples=[];expect(validateTemplate(forged).ok).toBe(true);const r=await save({...d,t:forged},1);expect(r.statusCode).toBe(422);expect(r.json().issues[0].path).toBe('definition');}
 expect(await counts(d.id.templateId)).toEqual(before);const input={...d,t:{...d.t,name:'Changed'}};expect((await save(input,1,'same')).statusCode).toBe(200);expect((await save(d,2,'same')).statusCode).toBe(409);
 const both=await Promise.all(['left','right'].map(name=>save({...d,t:{...d.t,name}},2,name)));expect(both.map(x=>x.statusCode).sort()).toEqual([200,409]);expect((await call('GET',d.url)).json().value.revision).toBe(3);
});
it('rejects valid client-forged model20 origin and preserves server-retained origin metadata',async()=>{
 const d=await seeded(),origin={templateId:randomUUID(),revision:1,sectionId:randomUUID()},forged=structuredClone(d.t);forged.sections[0].origin=origin;expect(validateTemplate(forged).ok).toBe(true);
 const before=await counts(d.id.templateId),bad=await save({...d,t:forged},1);expect(bad.statusCode).toBe(422);expect(bad.json().issues[0].path).toBe('origin');expect(await counts(d.id.templateId)).toEqual(before);
 // A retained origin comes from trusted stored data, never from accepting caller JSON.
 const trusted=await draft();trusted.t.sections[0].origin=origin;ok(await importCurrent(db.pool,JSON.stringify(trusted.t)));const edit=structuredClone(trusted.t);edit.name='Retained origin';expect((await save({...trusted,t:edit},1)).statusCode).toBe(200);
 delete edit.sections[0].origin;expect((await save({...trusted,t:edit},2)).json().issues[0].path).toBe('origin');
});
it('refuses model20 whole-template clone before identity, font references or receipts are written',async()=>{
 const d=await seeded(d=>{d.t.examples=[];});const revision=(await call('GET',d.url)).json().value.revision,key='unsupported-copy-'+randomUUID(),before=(await db.pool.query('SELECT count(*)::int n FROM templates')).rows;
 const r=await call('POST',d.url+'/clone',{sourceRevision:revision,name:'Unsupported copy',docKey:key,idempotencyKey:'copy'});expect(r.statusCode,r.body).toBe(422);expect(r.json().issues[0].code).toBe('VERSION_MISMATCH');expect((await db.pool.query('SELECT count(*)::int n FROM templates')).rows).toEqual(before);expect((await db.pool.query("SELECT * FROM authoring_receipts WHERE target=$1 AND operation='clone'",[d.id.templateId])).rows).toEqual([]);
});
it('keeps create/import model19-only and rejects model20 in either import direction atomically',async()=>{
 const d=await seeded(),legacy=await draft(19);expect((await save(legacy)).statusCode).toBe(200);const empty=await draft(),before=await counts(d.id.templateId);
 const create=await call('POST',d.url+'/sections',{expectedRevision:1,pageLayoutId:d.t.book.defaultPageLayoutId,idempotencyKey:'create'});expect(create.statusCode).toBe(422);expect(create.json().issues[0].code).toBe('VERSION_MISMATCH');
 for(const [source,target,revision]of [[d,empty,0],[legacy,d,1]]){const r=await call('POST',target.url+'/sections/import',{sourceTemplateId:source.id.templateId,sourceRevision:1,sourceSectionIds:[source.t.sections[0].id],expectedRevision:revision,beforeSectionId:null,idempotencyKey:randomUUID()});expect(r.statusCode).toBe(422);expect(r.json().issues[0].code).toBe('VERSION_MISMATCH');}
 expect(await counts(d.id.templateId)).toEqual(before);expect((await call('GET',empty.url)).json().value.revision).toBe(0);
});
it('composes actual model20 input for font readiness and pins one exact preview revision with retry isolation',async()=>{
 const d=await seeded(),readiness=await call('POST',d.url+'/font-readiness',{expectedRevision:1,sampleRequest:d.request});expect(readiness.statusCode,readiness.body).toBe(200);expect(readiness.json().value.fontReadiness).toMatchObject({status:'ready',checkedScope:'actual_input'});
 const validation=await call('POST','/authoring/validate',{definition:d.t,sampleRequest:d.request});expect(validation.statusCode,validation.body).toBe(200);expect(validation.json().value).toMatchObject({composed:true,fontReadiness:{status:'ready',checkedScope:'actual_input'}});
 const input={expectedRevision:1,sampleRequest:d.request,idempotencyKey:'preview'},r=await call('POST',d.url+'/previews',input);expect(r.statusCode,r.body).toBe(202);const id=r.json().value.jobId;expect((await call('POST',d.url+'/previews',input)).json().value.jobId).toBe(id);
 const row=(await db.pool.query('SELECT * FROM generation_jobs WHERE id=$1',[id])).rows[0],p=ok(prepareGeneration(ok(validateTemplate(d.t)),d.request));expect(row.preview_definition).toEqual(d.t);expect(row.preview_revision).toBe(1);expect(row.prepared_input).toEqual(p);expect(p.schemaVersion).toBe(3);expect(p.template.nodeModelVersion).toBe(20);expect((await db.pool.query('SELECT * FROM job_font_snapshots WHERE job_id=$1',[id])).rowCount).toBe(1);
 expect((await app.inject('/jobs/'+id)).statusCode).toBe(404);expect((await call('GET','/authoring/previews/'+id,undefined,other)).statusCode).toBe(404);
 const changed={...d,t:{...d.t,name:'After preview'}};expect((await save(changed,1)).statusCode).toBe(200);expect((await call('POST',d.url+'/previews',{...input,idempotencyKey:'stale'})).statusCode).toBe(409);expect((await call('POST',d.url+'/previews',input)).json().value.jobId).toBe(id);expect((await db.pool.query('SELECT preview_definition FROM generation_jobs WHERE id=$1',[id])).rows[0].preview_definition).toEqual(d.t);
},30000);
it('keeps unresolved model20 schema2 save separate from readiness and rejects invalid preview input without queuing',async()=>{
 const d=await draft();d.t.schemaVersion=2;const s=d.t.styles.body;d.t.styles.body={font:{kind:'unselected'},fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};const saved=await save(d);expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().value.fontReadiness).toMatchObject({status:'blocked',issues:[{code:'FONT_NOT_SELECTED'}]});
 const before=await counts(d.id.templateId);for(const q of [d.request,{...d.request,sections:[]},{...d.request,sections:[d.request.sections[0],d.request.sections[0]]}]){const r=await call('POST',d.url+'/previews',{expectedRevision:1,sampleRequest:q,idempotencyKey:randomUUID()});expect(r.statusCode).toBe(422);expect(r.json().ok).toBe(false);}expect(await counts(d.id.templateId)).toEqual(before);
});
it('retains only owned server-granted model20 font tuples; copied JSON cannot inherit retired rights',async()=>{
 const f=await stageFont(db.pool,root);await db.pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[f.id]);const d=await draft();d.t.schemaVersion=2;const style=d.t.styles.body;d.t.styles.body={font:f.fontSelection,fontSize:style.fontSize,lineHeightPt:style.lineHeightPt};expect((await save(d)).statusCode).toBe(200);
 await db.pool.query("UPDATE font_releases SET state='retired' WHERE id=$1",[f.id]);const own=await call('POST','/authoring/validate',{definition:d.t}),foreign=await call('POST','/authoring/validate',{definition:d.t},other);expect(own.json().value.fontReadiness.status).toBe('ready');expect(foreign.json().value.fontReadiness).toMatchObject({status:'blocked',issues:[{code:'FONT_REFERENCE_NOT_RETAINED'}]});
 const copy=await draft();copy.t={...structuredClone(d.t),templateId:copy.id.templateId,docKey:copy.id.docKey,examples:[]};const copied=await save(copy);expect(copied.statusCode,copied.body).toBe(200);expect(copied.json().value.fontReadiness.status).toBe('blocked');expect((await readReferences(db.pool,copy.id.templateId,1)).bindings).toEqual([]);
 d.t.name='Retained';expect((await save(d,1)).json().value.fontReadiness.status).toBe('ready');expect((await readReferences(db.pool,d.id.templateId,2)).bindings).toEqual([f.fontSelection].map(({releaseId,weight,style})=>({releaseId,weight,style})));
},30000);
it('describes route-specific whole-definition tools and model19-only clone without claiming client adoption',async()=>{
 const server=createAuthoringTools({baseUrl:'http://127.0.0.1:3018',token,fetch:async(url,init)=>{const r=await app.inject({method:init.method,url:new URL(url).pathname,headers:init.headers,...(init.body?{payload:init.body}:{})});return new Response(r.rawPayload,{status:r.statusCode,headers:{'content-type':'application/json'}});}}),client=new Client({name:'model20-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{const tools=(await client.listTools()).tools;for(const name of ['update_template_draft','validate_template','preview_template_draft'])expect(tools.find(t=>t.name===name).description).toContain('/authoring/contract');expect(tools.find(t=>t.name==='clone_template_draft').description).toMatch(/model20.*not supported/i);const c=JSON.parse((await client.callTool({name:'get_authoring_contract',arguments:{}})).content[0].text);expect(c.value.sectionDefinitions.model).toBe(20);}finally{await client.close();await server.close();}
});
