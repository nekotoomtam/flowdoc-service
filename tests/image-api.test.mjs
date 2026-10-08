import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase();let app,processor,uploads,root,resources,pdfFiles;
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
export function imageTemplate(){const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));t.templateId='uat-images';t.docKey='uat-images';t.nodeModelVersion=5;t.examples=[];
 t.globalSchema={type:'object',fields:{}};t.formats={};
 for(const [name,w,h] of [['photo',450,240],['small',225,120]])t.formats[name]={inputSchema:{type:'object',fields:{photo:{type:'image',required:true}}},fragment:{rootIds:['image'],nodes:{image:{id:'image',type:'image',props:{width:{value:w,unit:'pt'},height:{value:h,unit:'pt'},source:{scope:'local',key:'photo'}}}}},repeats:[]};return t;}
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));ok(await registerTemplate(db.pool,JSON.stringify(imageTemplate())));root=await mkdtemp(join(tmpdir(),'image-api-'));resources=await createResourceFiles(join(root,'staging'));uploads=createUploads({pool:db.pool,files:resources,config:readUploadConfig({})});const files=await createPdfFiles(join(root,'pdf'));pdfFiles=files;processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config:readUploadConfig({})}});app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:()=>processor.isReady(),imagesEnabled:true});});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();});
it('uploads JPEG/alpha PNG, exports repeated sizes with warnings/progress and immutable input',async()=>{
 const jpeg=await sharp({create:{width:3840,height:2160,channels:3,background:'#345678'}}).jpeg().toBuffer(),png=await sharp({create:{width:600,height:400,channels:4,background:{r:220,g:50,b:20,alpha:0.5}}}).png().toBuffer(),bad=Buffer.from('broken');
 const bytes=[jpeg,png,bad];const manifest={requestKey:'uat-mixed',items:bytes.map((b,i)=>({key:'p'+i,source:'upload',mediaType:i===0?'image/jpeg':'image/png',byteSize:b.length}))};
 const s=ok((await app.inject({method:'POST',url:'/uploads',payload:manifest})).json());
 for(let i=0;i<bytes.length;i++)expect((await app.inject({method:'PUT',url:`/uploads/${s.uploadId}/items/${s.items.find(x=>x.key==='p'+i).resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:bytes[i]})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${s.uploadId}/finalize`})).json());
 const ids=[0,1,2].map(i=>s.items.find(x=>x.key==='p'+i).resourceId);
 const request={docKey:'uat-images',uploadId:s.uploadId,data:{},content:[{format:'photo',data:{photo:ids[0]}},{format:'small',data:{photo:ids[0]}},{format:'photo',data:{photo:ids[1]}},{format:'photo',data:{photo:ids[2]}}]};
 const submitted=await app.inject({method:'POST',url:'/jobs',payload:request});expect(submitted.statusCode,submitted.body).toBe(202);const job=ok(submitted.json());
 expect(ok((await app.inject({method:'POST',url:'/jobs',payload:request})).json()).jobId).toBe(job.jobId);
 let view;for(let n=0;n<600;n++){view=ok((await app.inject({method:'GET',url:'/jobs/'+job.jobId})).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,25));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');expect(view.processing).toMatchObject({stage:'complete',completed:4,total:4});expect(view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);
 expect(ok((await app.inject({method:'POST',url:'/jobs',payload:request})).json()).status).toBe('succeeded');
 const pdf=await app.inject({method:'GET',url:`/jobs/${job.jobId}/pdf`});expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.toString('latin1')).toContain('/SMask');expect(pdf.rawPayload.toString('latin1')).toContain('/DCTDecode');
 const saved=(await db.pool.query('SELECT original_input,warnings_json FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0];expect(saved.original_input).toEqual(request);expect(saved.warnings_json).toEqual([]);
 expect((await readdir(join(root,'staging','jobs',job.jobId))).length).toBeGreaterThan(0);
 if(process.env.FLOWDOC_IMAGE_ARTIFACT)await writeFile(process.env.FLOWDOC_IMAGE_ARTIFACT,pdf.rawPayload);
 const directory=resources.jobDirectory(job.jobId);let size=bytes.reduce((n,b)=>n+b.length,0);for(const name of await readdir(directory))size+=(await stat(join(directory,name))).size;
 expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(size);
 await uploads.recover();expect((await readdir(directory)).length).toBeGreaterThan(0);
 const finish=+(await db.pool.query('SELECT finished_at FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0].finished_at;
 const later=createUploads({pool:db.pool,files:resources,config:readUploadConfig({}),clock:()=>finish+3599999});await later.cleanup();expect((await readdir(directory)).length).toBeGreaterThan(0);
 const expired=createUploads({pool:db.pool,files:resources,config:readUploadConfig({}),clock:()=>finish+3600000});await expired.cleanup();await expect(stat(directory)).rejects.toMatchObject({code:'ENOENT'});expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(0);
},60000);
it('rejects missing/wrong references and turns a blocked URL into a persisted warning',async()=>{
 const s=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:'blocked-url',items:[{key:'url',source:'url',url:'https://127.0.0.1/private'}]}})).json());
 ok((await app.inject({method:'POST',url:`/uploads/${s.uploadId}/finalize`})).json());
 const content=[{format:'photo',data:{photo:s.items[0].resourceId}}];
 expect((await app.inject({method:'POST',url:'/jobs',payload:{docKey:'uat-images',data:{},content}})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:'/jobs',payload:{docKey:'uat-images',data:{},uploadId:s.uploadId,content:[{format:'photo',data:{photo:'00000000-0000-4000-8000-000000000000'}}]}})).statusCode).toBe(422);
 const job=ok((await app.inject({method:'POST',url:'/jobs',payload:{docKey:'uat-images',data:{},uploadId:s.uploadId,content}})).json());
 let view;for(let n=0;n<500;n++){view=ok((await app.inject({method:'GET',url:'/jobs/'+job.jobId})).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status).toBe('succeeded');expect(view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);expect(JSON.stringify(view)).not.toContain('127.0.0.1');
 const item=(await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0];expect(Number(item.reserved_bytes)).toBe(0);
},30000);
it('keeps exporting with a warning when preparation capacity is exhausted without leaking bytes',async()=>{
 await processor.stop();const config=readUploadConfig({UPLOAD_FILE_BYTES:'1048576',UPLOAD_SET_BYTES:'1048576',UPLOAD_STAGING_BYTES:'1048576'});
 processor=await startProcessor({pool:db.pool,files:pdfFiles,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 const bytes=await sharp({create:{width:800,height:400,channels:3,background:'white'}}).jpeg().toBuffer();
 const s=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:'capacity',items:[{key:'photo',source:'upload',mediaType:'image/jpeg',byteSize:bytes.length}]}})).json());
 ok((await app.inject({method:'PUT',url:`/uploads/${s.uploadId}/items/${s.items[0].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:bytes})).json());ok((await app.inject({method:'POST',url:`/uploads/${s.uploadId}/finalize`})).json());
 const job=ok((await app.inject({method:'POST',url:'/jobs',payload:{docKey:'uat-images',data:{},uploadId:s.uploadId,content:[{format:'photo',data:{photo:s.items[0].resourceId}}]}})).json());
 let view;for(let n=0;n<500;n++){view=ok((await app.inject({method:'GET',url:'/jobs/'+job.jobId})).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status).toBe('succeeded');expect(view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);expect(await readdir(resources.jobDirectory(job.jobId))).toEqual([]);
 expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(bytes.length);
},30000);
