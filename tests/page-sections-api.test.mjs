import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const fixture=()=>JSON.parse(readFileSync('examples/page-sections-template.json','utf8'));
let app,processor,uploads,root;
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));const t=fixture();ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'v1'}));
 root=await mkdtemp(join(tmpdir(),'sections-api-'));const resources=await createResourceFiles(join(root,'staging')),files=await createPdfFiles(join(root,'pdf')),config=readUploadConfig({});
 uploads=createUploads({pool:db.pool,files:resources,config});processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady,imagesEnabled:true});
});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();if(root)await rm(root,{recursive:true,force:true});});
async function upload(){
 const b=await sharp({create:{width:800,height:400,channels:3,background:'#2870a0'}}).jpeg().toBuffer();
 const u=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:randomUUID(),items:[{key:'photo',source:'upload',mediaType:'image/jpeg',byteSize:b.length}]}})).json());
 expect((await app.inject({method:'PUT',url:`/uploads/${u.uploadId}/items/${u.items[0].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:b})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${u.uploadId}/finalize`})).json());return u;
}
it('exposes schemas without layout graph and preserves version after current label change',async()=>{
 const before=ok(await loadTemplate(db.pool,'page-sections',1));let c=ok(await loadCurrent(db.pool,'tpl-page-sections'));c.payload.pageLayouts.portrait.label='Renamed';c=ok(await saveCurrent(db.pool,c,c.revision));
 expect(ok(await publishCurrent(db.pool,{templateId:c.templateId,requestId:'v2'})).version).toBe(2);
 expect(ok(await loadTemplate(db.pool,'page-sections',1)).template).toEqual(before.template);
 const contract=ok((await app.inject('/templates/page-sections/contract?version=1')).json());expect(contract.globalSchema.fields.photo.type).toBe('image');expect(contract).not.toHaveProperty('sections');expect(contract).not.toHaveProperty('pageLayouts');expect(JSON.stringify(contract)).not.toContain('rootIds');
});
it('rejects invalid data before creating a job',async()=>{
 const before=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 expect((await app.inject({method:'POST',url:'/jobs',payload:{docKey:'page-sections',data:{},content:[]}})).statusCode).toBe(422);
 expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(before);
});
it('deletes authored Area and owned DB rows while published snapshot remains identical',async()=>{
 const t=fixture();t.templateId=t.docKey='sections-deletion';t.globalSchema.fields.details={type:'area',areaId:'static-area'};
 t.areaFormats.static={...structuredClone(t.areaFormats['format-002']),ownerAreaId:'static-area'};
 t.sections[0].source.fragment.rootIds.push('area');t.sections[0].source.fragment.nodes.area={id:'area',type:'area',props:{areaId:'static-area'}};
 ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'}));
 const before=ok(await loadTemplate(db.pool,t.docKey,1));let c=ok(await loadCurrent(db.pool,t.templateId));const owner=c.variables.find(v=>v.payload.areaId==='static-area');
 const removedFormats=c.formats.filter(f=>f.ownerAreaVariableId===owner.id).map(f=>f.id),removedSchemas=c.schemas.filter(s=>removedFormats.includes(s.formatId)).map(s=>s.id);
 c.variables=c.variables.filter(v=>v.id!==owner.id);c=ok(await saveCurrent(db.pool,c,c.revision));
 const after=ok(await loadCurrent(db.pool,t.templateId));expect(after.payload.sections[0].source.fragment.nodes.area).toBeUndefined();expect(after.payload.sections[0].source.fragment.rootIds).not.toContain('area');
 expect(after.formats.some(f=>removedFormats.includes(f.id))).toBe(false);expect(after.schemas.some(s=>removedSchemas.includes(s.id))).toBe(false);expect(after.variables.some(v=>removedSchemas.includes(v.schemaId)||v.id===owner.id)).toBe(false);
 expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'second'})).version).toBe(2);
 expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(before.template);
});
it('claims static images and exports both empty content and multi-section request through HTTP',async()=>{
 for(const mode of ['static','long']){
  const u=await upload(),r=JSON.parse(readFileSync('examples/page-sections-request.json','utf8'));r.version=1;r.uploadId=u.uploadId;r.data.photo=u.items[0].resourceId;
  if(mode==='static')r.content=[];else r.content[0].data.details[1].data.photo=u.items[0].resourceId;
  const receipt=await app.inject({method:'POST',url:'/jobs',payload:r});expect(receipt.statusCode,receipt.body).toBe(202);const job=ok(receipt.json());let view;
  for(let i=0;i<400;i++){view=ok((await app.inject('/jobs/'+job.jobId)).json());if(['succeeded','failed'].includes(view.status))break;await new Promise(r=>setTimeout(r,25));}
  expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+job.jobId+'/pdf');expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.rawPayload.toString('latin1')).toContain('/Subtype /Image');
  expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0].original_input).toEqual(r);
  if(process.env.EVIDENCE_DIR){await mkdir(process.env.EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.EVIDENCE_DIR,'page-sections-api-'+mode+'.pdf'),pdf.rawPayload);}
 }
},30000);
