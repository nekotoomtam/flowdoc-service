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
 await db.setup();ok(await migrate(db.pool));const t=JSON.parse(readFileSync('examples/area-template.json','utf8'));
 initial=ok(await importCurrent(db.pool,JSON.stringify(t)));version=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'repeat-v1'})).version;
 const root=await mkdtemp(join(tmpdir(),'repeat-api-')),resources=await createResourceFiles(join(root,'staging')),files=await createPdfFiles(join(root,'pdf')),config=readUploadConfig({});
 uploads=createUploads({pool:db.pool,files:resources,config});processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady,imagesEnabled:true});
});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();});
const request=items=>({docKey:'area-demo',version,data:{},content:[{format:'evidence',data:{details:items.map(data=>({format:'evidence',data}))}}]});
async function upload(bytes){
 const u=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:randomUUID(),items:bytes.map((b,i)=>({key:'p'+i,source:'upload',mediaType:'image/jpeg',byteSize:b.length}))}})).json());
 for(let i=0;i<bytes.length;i++)expect((await app.inject({method:'PUT',url:`/uploads/${u.uploadId}/items/${u.items[i].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:bytes[i]})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${u.uploadId}/finalize`})).json());return u;
}
async function finish(r){const response=await app.inject({method:'POST',url:'/jobs',payload:r});expect(response.statusCode,response.body).toBe(202);const job=ok(response.json());let view;
 for(let i=0;i<1200;i++){view=ok((await app.inject('/jobs/'+job.jobId)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');return {job,view,pdf:await app.inject('/jobs/'+job.jobId+'/pdf')};}
it('renders actual area images and retains skipped warnings',async()=>{
 const good=await sharp({create:{width:800,height:400,channels:3,background:'#2870a0'}}).jpeg().toBuffer(),u=await upload([good,Buffer.from('bad-image')]);
 const r={...request([0,0,1].map((index,i)=>({photo:u.items[index].resourceId,caption:'AREA-'+i+'\n'+'ตรวจสอบหลักฐาน\n'.repeat(8)}))),uploadId:u.uploadId};
 r.content[0].data.details.splice(1,0,{format:'missing',data:{photo:'99999999-9999-4999-8999-999999999999'}});
 const result=await finish(r);expect(result.pdf.statusCode).toBe(200);expect(result.pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');expect(result.view.warnings.some(w=>w.code==='AREA_ENTRY_SKIPPED')).toBe(true);expect(result.view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);
 const raw=result.pdf.rawPayload.toString('latin1');expect((raw.match(/\/Subtype \/Image/g)??[]).length).toBe(1);
 expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[result.job.jobId])).rows[0].original_input).toEqual(r);
});
it('renders empty and all skipped without upload, rejects accepted foreign resource',async()=>{
 for(const details of [[],[{format:'missing',data:{}}]]){const r=request([]);r.content[0].data.details=details;expect((await finish(r)).pdf.statusCode).toBe(200);}
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).jpeg().toBuffer(),a=await upload([bytes]),b=await upload([bytes]);const r={...request([{photo:a.items[0].resourceId,caption:'foreign'}]),uploadId:b.uploadId};expect((await app.inject({method:'POST',url:'/jobs',payload:r})).statusCode).toBe(422);
});
