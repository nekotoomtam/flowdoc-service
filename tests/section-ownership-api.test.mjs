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
const fixture=()=>JSON.parse(readFileSync('examples/section-ownership-template.json','utf8'));
let app,processor,uploads,root;
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));const t=fixture();for(const section of t.sections){section.header.inputSchema.fields.photo={type:'image'};section.header.fragment.rootIds.push('image');section.header.fragment.nodes.image={id:'image',type:'image',props:{width:{value:40,unit:'pt'},height:{value:30,unit:'pt'},source:{scope:'header',key:'photo'}}};}ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'v1'}));
 root=await mkdtemp(join(tmpdir(),'sections-api-'));const resources=await createResourceFiles(join(root,'staging')),files=await createPdfFiles(join(root,'pdf')),config=readUploadConfig({});
 uploads=createUploads({pool:db.pool,files:resources,config});processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:()=>true,imagesEnabled:true});
});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();if(root)await rm(root,{recursive:true,force:true});});
async function upload(){
 const b=await sharp({create:{width:800,height:400,channels:3,background:'#2870a0'}}).jpeg().toBuffer();
 const u=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:randomUUID(),items:[{key:'photo',source:'upload',mediaType:'image/jpeg',byteSize:b.length}]}})).json());
 expect((await app.inject({method:'PUT',url:`/uploads/${u.uploadId}/items/${u.items[0].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:b})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${u.uploadId}/finalize`})).json());return u;
}

const request=()=>JSON.parse(readFileSync('examples/section-ownership-request.json','utf8'));
async function waitJob(id){let view;for(let i=0;i<400;i++){view=ok((await app.inject('/jobs/'+id)).json());if(['succeeded','failed'].includes(view.status))break;await new Promise(r=>setTimeout(r,25));}return view;}
it('returns scoped contracts without graphs and retains old published labels',async()=>{
 const url='/templates/section-ownership/contract?version=1',before=ok((await app.inject(url)).json());expect(Object.keys(before.sections)).toEqual(['intro','details','closing']);expect(before.sections.intro.header.fields.photo.type).toBe('image');expect(JSON.stringify(before)).not.toContain('rootIds');
 let current=ok(await loadCurrent(db.pool,'tpl-section-ownership'));current.sections[0].label='renamed';ok(await saveCurrent(db.pool,current,current.revision));ok(await publishCurrent(db.pool,{templateId:current.templateId,requestId:'new'}));expect(ok((await app.inject(url)).json())).toEqual(before);
});
it('rejects mixed and sole unknown sections with no new jobs and precise required paths',async()=>{
 const before=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 for(const sections of [{typo:{}},{intro:{},typo:{}}]){const r=request();r.sections=sections;const res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode,res.body).toBe(422);expect(res.json().issues.some(i=>i.code==='UNKNOWN_SECTION'&&i.path==='sections.typo')).toBe(true);}
 expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(before);
});
it('reloads direct and staged scoped requests, claims each section image and leaves originals unchanged',async()=>{
 for(const staged of [false,true]){const r=request();r.version=1;r.sections={closing:r.sections.closing,details:r.sections.details,intro:r.sections.intro};r.sections.intro.data.zzzz='ignored';r.sections.intro.data.a='ignored';
 if(staged){const resources=[];const u=await upload();resources.push(u);r.uploadId=u.uploadId;for(const key of Object.keys(r.sections))r.sections[key].header={name:'band '+key,photo:u.items[0].resourceId};}
 const res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode,res.body).toBe(202);const id=ok(res.json()).jobId,view=await waitJob(id);expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+id+'/pdf');expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');if(staged)expect(pdf.rawPayload.toString('latin1')).toContain('/Subtype /Image');
 expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[id])).rows[0].original_input).toEqual(r);
 }
},30000);
it('rejects corrupted prepared section input on worker reload',async()=>{
 await processor.stop();processor=undefined;const res=await app.inject({method:'POST',url:'/jobs',payload:request()});expect(res.statusCode).toBe(202);const accepted=ok(res.json()).jobId;
 await expect(db.pool.query(`UPDATE generation_jobs SET prepared_input=jsonb_set(prepared_input,'{sections,section-intro,data,title}','"FORGED"') WHERE id=$1`,[accepted])).rejects.toBeDefined();
 const id=(await db.pool.query(`INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) SELECT uuidv7(),template_version_id,original_input,jsonb_set(prepared_input,'{sections,section-intro,data,title}','"FORGED"'),warnings_json,skipped_indices FROM generation_jobs WHERE id=$1 RETURNING id`,[accepted])).rows[0].id;

 processor=await startProcessor({pool:db.pool,files:await createPdfFiles(join(root,'pdf')),policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:await createResourceFiles(join(root,'staging')),config:readUploadConfig({})}});expect((await waitJob(id)).status).toBe('failed');expect((await app.inject('/jobs/'+id+'/pdf')).statusCode).not.toBe(200);
},30000);
