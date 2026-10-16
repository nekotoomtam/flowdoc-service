import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createAuthoringTools} from '../dist/tools/authoring.js';
import {startProcessor} from '../dist/jobs/processor.js';
const db=isolatedDatabase();let app,other,client,server;const token='s'.repeat(40),headers={authorization:'Bearer '+token};
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);app=createServer({pool:db.pool,isReady:()=>true,outputs:{},imagesEnabled:false,authoring:{token,principal:'section-owner'}});other=createServer({pool:db.pool,isReady:()=>true,outputs:{},imagesEnabled:false,authoring:{token,principal:'other-owner'}});server=createAuthoringTools({baseUrl:'http://127.0.0.1:3018',token,fetch:async(url,init)=>{const r=await app.inject({method:init.method,url:new URL(url).pathname,headers:init.headers,...(init.body?{payload:init.body}:{})});return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});}});client=new Client({name:'instance-native-check',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);});
afterAll(async()=>{await client?.close();await server?.close();await app?.close();await other?.close();await db.close();});
const call=(method,url,payload,s=app)=>s.inject({method,url,headers,...(payload?{payload}:{})});
const tool=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
async function create(name){const r=await call('POST','/authoring/drafts',{name,docKey:name+'-'+randomUUID(),idempotencyKey:randomUUID()});expect(r.statusCode,r.body).toBe(201);return r.json().value;}
function definition(identity){const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.templateId=identity.templateId;t.docKey=identity.docKey;t.name=identity.name;t.nodeModelVersion=19;t.examples=[];const s=t.sections[0];s.id=randomUUID();s.label='SRS1';s.nameBase='SRS';delete s.key;delete s.formats;return t;}
it('saves/opens/clones/imports through native tools with independent Section IDs and exact retry',async()=>{
 const a=await create('source'),t=definition(a);const saved=await tool('update_template_draft',{templateId:a.templateId,definition:t,expectedRevision:0,idempotencyKey:'save'});expect(saved.ok,JSON.stringify(saved)).toBe(true);
 const args={templateId:a.templateId,sourceTemplateId:a.templateId,sourceRevision:1,sourceSectionIds:[t.sections[0].id],expectedRevision:1,beforeSectionId:null,idempotencyKey:'copy'};
 const copied=await tool('import_draft_sections',args);expect(copied.ok,JSON.stringify(copied)).toBe(true);expect(copied.value.revision).toBe(2);expect((await tool('import_draft_sections',args)).value.sectionIdMap).toEqual(copied.value.sectionIdMap);
 const opened=await tool('get_template_draft',{templateId:a.templateId});expect(opened.value.definition.sections.map(s=>s.label)).toEqual(['SRS1','SRS2']);
 const ids=opened.value.definition.sections.map(s=>s.id);expect(new Set(ids).size).toBe(2);
 const clone=await tool('clone_template_draft',{templateId:a.templateId,sourceRevision:2,name:'Copy',docKey:'copy-'+randomUUID(),idempotencyKey:'clone'});expect(clone.ok,JSON.stringify(clone)).toBe(true);expect(clone.value.definition.sections.every(s=>!ids.includes(s.id))).toBe(true);expect(Object.keys(clone.value.sectionIdMap)).toEqual(ids);
 const target=await create('split');const split=await tool('import_draft_sections',{...args,templateId:target.templateId,sourceRevision:2,sourceSectionIds:[ids[1]],expectedRevision:0,idempotencyKey:'split'});expect(split.ok,JSON.stringify(split)).toBe(true);expect(split.value.revision).toBe(1);expect((await tool('get_template_draft',{templateId:a.templateId})).value.revision).toBe(2);
 const data=opened.value.definition.sections.map((s,i)=>({id:s.id,data:{details:[{format:'meeting',data:{companies:[{name:i?'Beta':'Alpha',members:[]}]}}]}})).reverse();
 const v=await tool('validate_template',{definition:opened.value.definition,sampleRequest:{docKey:a.docKey,data:t.globalSchema.fields.projectName?{projectName:'Example'}:{},sections:data}});expect(v.ok,JSON.stringify(v)).toBe(true);
 if(process.platform==='linux'){
  const job=await tool('preview_template_draft',{templateId:a.templateId,expectedRevision:2,sampleRequest:{docKey:a.docKey,data:{},sections:data},idempotencyKey:'model19-preview'});expect(job.ok,JSON.stringify(job)).toBe(true);
  const pin=(await db.pool.query('SELECT prepared_input,preview_definition FROM generation_jobs WHERE id=$1',[job.value.jobId])).rows[0];expect(pin.prepared_input).toMatchObject({schemaVersion:2,template:{nodeModelVersion:19}});expect(pin.preview_definition.nodeModelVersion).toBe(19);
  let bytes=0;const processor=await startProcessor({pool:db.pool,files:{writePdf:async(id,b)=>{expect(Buffer.from(b).subarray(0,5).toString()).toBe('%PDF-');bytes=b.length;return {path:id+'.pdf',byteSize:b.length};}},policy:{retain:true,ttlHours:24,tempHours:24},pollMs:10});
  try{let status;for(let n=0;n<400;n++){status=(await db.pool.query('SELECT status,errors_json FROM generation_jobs WHERE id=$1',[job.value.jobId])).rows[0];if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}expect(status,JSON.stringify(status)).toMatchObject({status:'succeeded'});expect(bytes).toBeGreaterThan(1000);}finally{await processor.stop();}
 }
});
it('rejects cross-owner/stale/retry-conflict/missing selections without advancing target revision',async()=>{
 const a=await create('guard'),t=definition(a);expect((await call('PUT','/authoring/drafts/'+a.templateId,{definition:t,expectedRevision:0,idempotencyKey:'save'})).statusCode).toBe(200);
 const path='/authoring/drafts/'+a.templateId+'/sections/import',body={sourceTemplateId:a.templateId,sourceRevision:1,sourceSectionIds:[t.sections[0].id],expectedRevision:1,beforeSectionId:null,idempotencyKey:'guard'};
 expect((await call('POST',path,body,other)).statusCode).toBe(404);
 expect((await call('POST',path,{...body,expectedRevision:0})).statusCode).toBe(409);
 expect((await call('POST',path,{...body,sourceSectionIds:[randomUUID()]})).statusCode).toBe(422);
 expect((await call('GET','/authoring/drafts/'+a.templateId)).json().value.revision).toBe(1);
 const results=await Promise.all(['one','two'].map(k=>call('POST',path,{...body,idempotencyKey:k})));expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
 const ok=results.find(r=>r.statusCode===200),k=results.indexOf(ok)===0?'one':'two';expect((await call('POST',path,{...body,idempotencyKey:k,beforeSectionId:t.sections[0].id})).statusCode).toBe(409);
});
it('keeps model18 save/open/clone on the old identity and data path',async()=>{const a=await create('legacy'),t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));Object.assign(t,{templateId:a.templateId,docKey:a.docKey,name:a.name});expect((await call('PUT','/authoring/drafts/'+a.templateId,{definition:t,expectedRevision:0,idempotencyKey:'old'})).statusCode).toBe(200);const r=await tool('clone_template_draft',{templateId:a.templateId,sourceRevision:1,name:'Old copy',docKey:'old-copy-'+randomUUID(),idempotencyKey:'clone'});expect(r.ok).toBe(true);expect(r.value.definition.nodeModelVersion).toBe(18);expect(r.value.definition.sections[0].id).toBe(t.sections[0].id);});
it('rolls back graph, revision, font references, audit and receipt after a late write failure',async()=>{
 const a=await create('rollback'),t=definition(a);expect((await call('PUT','/authoring/drafts/'+a.templateId,{definition:t,expectedRevision:0,idempotencyKey:'save'})).statusCode).toBe(200);
 const graph=await db.pool.query('SELECT id FROM sections WHERE template_id=$1',[a.templateId]);
 await db.pool.query("CREATE FUNCTION fail_section_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='import-sections' THEN RAISE EXCEPTION 'isolated fault'; END IF; RETURN NEW; END; $$; CREATE TRIGGER injected_fault BEFORE INSERT ON authoring_audit FOR EACH ROW EXECUTE FUNCTION fail_section_audit()");
 const args={sourceTemplateId:a.templateId,sourceRevision:1,sourceSectionIds:[t.sections[0].id],expectedRevision:1,beforeSectionId:null,idempotencyKey:'rollback'};
 try{expect((await call('POST','/authoring/drafts/'+a.templateId+'/sections/import',args)).statusCode).toBe(503);expect((await call('GET','/authoring/drafts/'+a.templateId)).json().value.revision).toBe(1);expect((await db.pool.query('SELECT id FROM sections WHERE template_id=$1',[a.templateId])).rows).toEqual(graph.rows);expect((await db.pool.query("SELECT count(*) FROM authoring_receipts WHERE target=$1 AND request_key='rollback'",[a.templateId])).rows[0].count).toBe('0');expect((await db.pool.query('SELECT count(*) FROM font_reference_sets WHERE template_id=$1',[a.templateId])).rows[0].count).toBe('1');}
 finally{await db.pool.query('DROP TRIGGER injected_fault ON authoring_audit; DROP FUNCTION fail_section_audit()');}
 expect((await call('POST','/authoring/drafts/'+a.templateId+'/sections/import',args)).statusCode).toBe(200);
});
it('preserves normalized identity on label/reorder edits and rejects client origin forgery',async()=>{
 const a=await create('stable'),t=definition(a);expect((await tool('update_template_draft',{templateId:a.templateId,definition:t,expectedRevision:0,idempotencyKey:'save'})).ok).toBe(true);
 const blank=await tool('create_draft_section',{templateId:a.templateId,expectedRevision:1,pageLayoutId:t.book.defaultPageLayoutId,idempotencyKey:'blank'});expect(blank.ok,JSON.stringify(blank)).toBe(true);const d=blank.value.definition,rows=(await db.pool.query('SELECT id,source_definition_id FROM sections WHERE template_id=$1 ORDER BY id',[a.templateId])).rows;d.sections.reverse();d.sections[0].label=d.sections[1].label;
 expect((await tool('update_template_draft',{templateId:a.templateId,definition:d,expectedRevision:2,idempotencyKey:'reorder'})).ok).toBe(true);expect((await db.pool.query('SELECT id,source_definition_id FROM sections WHERE template_id=$1 ORDER BY id',[a.templateId])).rows).toEqual(rows);
 d.sections[0].origin={templateId:a.templateId,revision:1,sectionId:t.sections[0].id};expect((await tool('update_template_draft',{templateId:a.templateId,definition:d,expectedRevision:3,idempotencyKey:'forge'})).ok).toBe(false);
 const legacy=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));Object.assign(legacy,{templateId:a.templateId,docKey:a.docKey});const downgrade=await tool('update_template_draft',{templateId:a.templateId,definition:legacy,expectedRevision:3,idempotencyKey:'downgrade'});expect(downgrade.ok).toBe(false);expect(downgrade.issues[0].code).toBe('VERSION_MISMATCH');
});
it('never resurrects a deleted public Section ID through full-definition save',async()=>{
 const a=await create('tombstone'),t=definition(a);expect((await tool('update_template_draft',{templateId:a.templateId,definition:t,expectedRevision:0,idempotencyKey:'save'})).ok).toBe(true);
 const added=await tool('create_draft_section',{templateId:a.templateId,expectedRevision:1,pageLayoutId:t.book.defaultPageLayoutId,idempotencyKey:'new'}),d=added.value.definition,removed=d.sections.pop();
 expect((await tool('update_template_draft',{templateId:a.templateId,definition:d,expectedRevision:2,idempotencyKey:'delete'})).ok).toBe(true);
 d.sections.push(removed);const restore=await tool('update_template_draft',{templateId:a.templateId,definition:d,expectedRevision:3,idempotencyKey:'reuse'});expect(restore.ok).toBe(false);expect(restore.issues[0].code).toBe('SECTION_ID_REUSED');expect((await tool('get_template_draft',{templateId:a.templateId})).value.revision).toBe(3);
});
