import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stageFont} from './fontFixture.mjs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {fixture} from './groupLabelFixture.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {createAuthoringTools} from '../dist/tools/authoring.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {rendererIdentity} from '../dist/fonts/snapshot.js';
const db=isolatedDatabase(),token='g'.repeat(40),headers={authorization:'Bearer '+token};
let app,other,client,tools,processor,root,files;
beforeAll(async()=>{
 await db.setup();expect((await migrate(db.pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'group-label-stage3-'));files=await createPdfFiles(root);
 const options={pool:db.pool,isReady:()=>true,outputs:createOutputs(db.pool,files,24),imagesEnabled:false};
 app=createServer({...options,authoring:{token,principal:'group-owner'}});other=createServer({...options,authoring:{token,principal:'other-owner'}});
 tools=createAuthoringTools({baseUrl:'http://127.0.0.1:3018',token,fetch:async(url,init)=>{
  const r=await app.inject({method:init.method,url:new URL(url).pathname,headers:init.headers,...(init.body?{payload:init.body}:{})});return new Response(r.rawPayload,{status:r.statusCode,headers:{'content-type':r.headers['content-type']}});
 }});
 client=new Client({name:'group-label-stage3',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await tools.connect(a);await client.connect(b);
});
afterAll(async()=>{await processor?.stop();await client?.close();await tools?.close();await app?.close();await other?.close();await db.close();if(root)await rm(root,{recursive:true,force:true});});
const tool=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
async function save(options){
 const {t,q}=fixture(options),a=ok(await tool('create_template_draft',{name:'Groups',docKey:'groups-'+randomUUID(),idempotencyKey:randomUUID()}));
 Object.assign(t,{templateId:a.templateId,docKey:a.docKey});q.docKey=a.docKey;
 ok(await tool('update_template_draft',{templateId:a.templateId,definition:t,expectedRevision:0,idempotencyKey:randomUUID()}));return {t,q};
}
const preview=async(t,q,revision=1)=>ok(await tool('preview_template_draft',{templateId:t.templateId,expectedRevision:revision,sampleRequest:q,idempotencyKey:randomUUID()})).jobId;
const start=async()=>processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},pollMs:10});
async function finish(id,name){
 let status;for(let i=0;i<1000;i++){status=ok(await tool('get_preview_status',{jobId:id}));if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}
 if(status.status==='succeeded'){
  const pdf=await app.inject({url:'/authoring/previews/'+id+'/pdf',headers});expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
  if(process.env.GROUP_LABEL_PROOF_DIR){await mkdir(process.env.GROUP_LABEL_PROOF_DIR,{recursive:true});await writeFile(join(process.env.GROUP_LABEL_PROOF_DIR,name+'.pdf'),pdf.rawPayload);await writeFile(join(process.env.GROUP_LABEL_PROOF_DIR,name+'.json'),JSON.stringify(status,null,2));}
 }return status;
}
it('round-trips, pins and clones/imports two independent copies through tools with owner isolation',async()=>{
 const {t,q}=await save({fixed:true,height:120}),opened=ok(await tool('get_template_draft',{templateId:t.templateId}));expect(opened.definition).toEqual(t);
 const groupLabel=t.areaFormats.meeting.rowGroups[0].groupLabel;
 const clone=ok(await tool('clone_template_draft',{templateId:t.templateId,sourceRevision:1,name:'Copy',docKey:'copy-'+randomUUID(),idempotencyKey:randomUUID()}));
 const copiedLabel=Object.values(clone.definition.areaFormats)[0].rowGroups[0].groupLabel;expect(copiedLabel).toEqual(groupLabel);expect(clone.definition.sections[0].id).not.toBe(t.sections[0].id);
 const imported=ok(await tool('import_draft_sections',{templateId:clone.templateId,sourceTemplateId:t.templateId,sourceRevision:1,sourceSectionIds:[t.sections[0].id],expectedRevision:1,beforeSectionId:null,idempotencyKey:randomUUID()}));
 expect(new Set(imported.definition.sections.map(s=>s.id)).size).toBe(2);expect(Object.values(imported.definition.areaFormats).map(f=>f.rowGroups[0].groupLabel)).toEqual([groupLabel,groupLabel]);
 const cq={docKey:clone.docKey,data:{},sections:imported.definition.sections.map((s,i)=>({id:s.id,data:Object.fromEntries(Object.keys(s.inputSchema.fields).map(k=>[k,[{format:Object.values(imported.definition.areaFormats).find(f=>f.ownerAreaId===s.inputSchema.fields[k].areaId).key,data:{companies:[{name:'SAME',members:[{name:i?'COPY-B':'COPY-A'}]}]}}]]))}))};
 ok(await tool('validate_template',{definition:imported.definition,sampleRequest:cq}));
 const jobs=[await preview(t,q),await preview(imported.definition,cq,2)];
 const later=structuredClone(t);later.styles.body.fontSize.value=13;
 ok(await tool('update_template_draft',{templateId:t.templateId,definition:later,expectedRevision:1,idempotencyKey:randomUUID()}));
 expect((await app.inject({url:'/authoring/drafts/'+t.templateId,headers:{}})).statusCode).toBe(401);
 for(const url of ['/authoring/drafts/'+t.templateId,'/authoring/previews/'+jobs[0]])expect((await other.inject({url,headers})).statusCode).toBe(404);
 expect((await other.inject({method:'POST',url:'/authoring/drafts/'+t.templateId+'/clone',headers,payload:{sourceRevision:2,name:'Theft',docKey:'theft',idempotencyKey:'theft'}})).statusCode).toBe(404);
 expect((await other.inject({method:'POST',url:'/authoring/drafts/'+clone.templateId+'/sections/import',headers,payload:{sourceTemplateId:t.templateId,sourceRevision:2,sourceSectionIds:[t.sections[0].id],expectedRevision:2,beforeSectionId:null,idempotencyKey:'theft'}})).statusCode).toBe(404);
 await start();
 for(const [i,id] of jobs.entries()){
  const status=await finish(id,i?'copies':'fixed');expect(status,JSON.stringify(status)).toMatchObject({status:'succeeded',revision:i?2:1});
  const pin=(await db.pool.query('SELECT preview_definition,original_input FROM generation_jobs WHERE id=$1',[id])).rows[0];expect(pin.preview_definition).toEqual(i?imported.definition:t);expect(pin.original_input).toEqual(i?cq:q);
  const snapshot=(await db.pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[id])).rows[0].snapshot;expect(snapshot.rendererIdentity).toEqual(rendererIdentity);expect(snapshot.legacy).toHaveLength(4);
  if(!i){const w=status.warnings.find(w=>w.code==='FORMAT_CONTENT_OMITTED');expect(w.formatOmission.pending.some(p=>p.groupId==='companies'&&p.groupIndex===0&&Number.isInteger(p.itemIndex))).toBe(true);}
 }
 await processor.stop();processor=undefined;
});
it('returns bounded group-label layout errors and font readiness through tools without exposing partial output',async()=>{
 const {t,q}=await save({height:100,name:Array(9).fill('NAME').join('\n'),members:0});
 expect(ok(await tool('get_draft_font_readiness',{templateId:t.templateId,expectedRevision:1,sampleRequest:q})).fontReadiness.status).toBe('ready');
 const id=await preview(t,q);await start();const status=await finish(id,'impossible');
 expect(status,JSON.stringify(status)).toMatchObject({status:'failed',outputAvailable:false,errors:[{code:'LAYOUT_FAILED',reason:'group-label-does-not-fit',groupId:'companies',groupIndex:0,nodeId:expect.any(String)}]});
 expect((await app.inject({url:'/authoring/previews/'+id+'/pdf',headers})).statusCode).toBe(409);await processor.stop();processor=undefined;
});
it('renders auto continuation through the real child and rejects invalid nested input before enqueue',async()=>{
 const {t,q}=await save({height:160,members:8});const bad=structuredClone(q);bad.sections[0].data.content[0].data.companies[0].name='';
 expect((await tool('validate_template',{definition:t,sampleRequest:bad})).ok).toBe(false);
 const id=await preview(t,q);await start();expect(await finish(id,'auto')).toMatchObject({status:'succeeded',warnings:[]});await processor.stop();processor=undefined;
});
it('blocks only auto when a released schema2 label font lacks a generated suffix glyph, before queuing',async()=>{
 const fonts=join(root,'fonts'),source=join(root,'subset');await mkdir(source,{recursive:true});
 const original=fileURLToPath(new URL('../node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf',import.meta.url)),font=join(source,'Sarabun-Regular.ttf');
 await copyFile(fileURLToPath(new URL('../node_modules/@flowdoc/core/assets/fonts/OFL.txt',import.meta.url)),join(source,'OFL.txt'));
 execFileSync(process.env.PYTHON_EXECUTABLE??'python',['-c','from fontTools.ttLib import TTFont; import sys; f=TTFont(sys.argv[1]); [(t.cmap.pop(0x0e15,None)) for t in f["cmap"].tables if t.isUnicode()]; f.save(sys.argv[2])',original,font]);
 const staged=await stageFont(db.pool,fonts,font);await db.pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[staged.id]);
 const prior=process.env.FONT_STORAGE_DIR;process.env.FONT_STORAGE_DIR=fonts;
 try{for(const fixed of [true,false]){
  const {t,q}=fixture({fixed}),identity=ok(await tool('create_template_draft',{name:'Suffix font',docKey:'suffix-'+randomUUID(),idempotencyKey:randomUUID()}));
  Object.assign(t,{templateId:identity.templateId,docKey:identity.docKey,schemaVersion:2});q.docKey=t.docKey;
  for(const [key,s] of Object.entries(t.styles))t.styles[key]={font:staged.fontSelection,fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};
  ok(await tool('update_template_draft',{templateId:t.templateId,expectedRevision:0,definition:t,idempotencyKey:randomUUID()}));
  const readiness=ok(await tool('get_draft_font_readiness',{templateId:t.templateId,expectedRevision:1,sampleRequest:q})).fontReadiness;
  if(fixed)expect(readiness.status,JSON.stringify(readiness)).toBe('ready');
  else{
   expect(readiness).toMatchObject({status:'blocked',issues:[{code:'FONT_GLYPH_MISSING',styleIds:['body'],samples:expect.arrayContaining(['U+0E15'])}]});
   const count=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
   expect((await tool('preview_template_draft',{templateId:t.templateId,expectedRevision:1,sampleRequest:q,idempotencyKey:randomUUID()})).ok).toBe(false);
   expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(count);
  }
 }}finally{if(prior===undefined)delete process.env.FONT_STORAGE_DIR;else process.env.FONT_STORAGE_DIR=prior;}
});
