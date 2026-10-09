import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {composeDocument,prepareGeneration} from '@flowdoc/core';
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
let app,processor,uploads,version,initial;
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));const t=JSON.parse(readFileSync('examples/cell-repeat-template.json','utf8'));
 initial=ok(await importCurrent(db.pool,JSON.stringify(t)));version=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'repeat-v1'})).version;
 const root=await mkdtemp(join(tmpdir(),'repeat-api-')),resources=await createResourceFiles(join(root,'staging')),files=await createPdfFiles(join(root,'pdf')),config=readUploadConfig({});
 uploads=createUploads({pool:db.pool,files:resources,config});processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady,imagesEnabled:true});
});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();});
const request=items=>({docKey:'cell-repeat',version,data:{},content:[{format:'evidence',data:{evidenceList:items}}]});
async function upload(bytes){
 const u=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:randomUUID(),items:bytes.map((b,i)=>({key:'p'+i,source:'upload',mediaType:'image/jpeg',byteSize:b.length}))}})).json());
 for(let i=0;i<bytes.length;i++)expect((await app.inject({method:'PUT',url:`/uploads/${u.uploadId}/items/${u.items[i].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:bytes[i]})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${u.uploadId}/finalize`})).json());return u;
}
async function finish(r){const response=await app.inject({method:'POST',url:'/jobs',payload:r});expect(response.statusCode,response.body).toBe(202);const job=ok(response.json());let view;
 for(let i=0;i<1200;i++){view=ok((await app.inject('/jobs/'+job.jobId)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');return {job,view,pdf:await app.inject('/jobs/'+job.jobId+'/pdf')};}
it('keeps version1 array children and repeat declaration independent of current/version2',async()=>{
 const old=ok(await loadTemplate(db.pool,'cell-repeat',version)),r=ok(await loadCurrent(db.pool,'cell-repeat'));
 r.variables.find(v=>v.key==='caption').payload.default='V2 caption';r.formats.find(f=>f.key==='evidence').payload.cellRepeats[0].id='v2-repeat';
 ok(await saveCurrent(db.pool,r,r.revision));const v2=ok(await publishCurrent(db.pool,{templateId:r.templateId,requestId:'repeat-v2'}));
 expect(v2.version).toBe(2);const unchanged=ok(await loadTemplate(db.pool,'cell-repeat',version));expect(unchanged.template).toEqual(old.template);
 const latest=ok(await loadTemplate(db.pool,'cell-repeat',2));expect(latest.template.definition.formats.evidence.cellRepeats[0].id).toBe('v2-repeat');
 expect(latest.template.definition.formats.evidence.inputSchema.fields.evidenceList.items.fields.caption.default).toBe('V2 caption');
 const versions=await db.pool.query('SELECT id FROM variable_versions');const currentIds=new Set(initial.variables.map(v=>v.id));expect(versions.rows.every(v=>!currentIds.has(v.id))).toBe(true);
 const d=ok(composeDocument(old.template,ok(prepareGeneration(old.template,request([])))));expect(d.nodes['content-0~cell'].childIds).toEqual(['content-0~heading','content-0~footer']);
});
it('renders array images, reuses resources, warns on bad image and preserves input',async()=>{
 const good=await sharp({create:{width:800,height:400,channels:3,background:'#2870a0'}}).jpeg().toBuffer(),u=await upload([good,Buffer.from('bad-image')]);
 const r={...request([0,0,1].map((index,i)=>({photo:u.items[index].resourceId,caption:'CAP-'+i+'\n'+'ตรวจสอบรายการภาพและข้อความ\n'.repeat(25)}))),uploadId:u.uploadId};
 const {job,view,pdf}=await finish(r);expect(pdf.statusCode).toBe(200);expect(view.processing).toMatchObject({stage:'complete',completed:3,total:3});expect(view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);
 expect((pdf.rawPayload.toString('latin1').match(/\/Subtype \/Image/g)??[]).length).toBe(1);
 expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0].original_input).toEqual(r);
},60000);
it('rejects invalid item data before enqueue and renders empty list without upload',async()=>{
 const before=Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count);
 for(const item of [{caption:'missing'},{photo:42}]){const response=await app.inject({method:'POST',url:'/jobs',payload:request([item])});expect(response.statusCode).toBeGreaterThanOrEqual(400);expect(response.json().issues.some(i=>i.path==='content[0].data.evidenceList[0].photo')).toBe(true);}
 expect(Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count)).toBe(before);
 const {pdf}=await finish(request([]));expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.toString('latin1')).not.toContain('/Subtype /Image');
},60000);
it('does not claim a resource from another finalized upload',async()=>{
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#2870a0'}}).jpeg().toBuffer(),a=await upload([bytes]),b=await upload([bytes]);
 const response=await app.inject({method:'POST',url:'/jobs',payload:{...request([{photo:b.items[0].resourceId}]),uploadId:a.uploadId}});expect(response.statusCode).toBeGreaterThanOrEqual(400);expect(response.json().ok).toBe(false);
});
