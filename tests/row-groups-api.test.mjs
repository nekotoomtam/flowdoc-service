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
const fixture=()=>JSON.parse(readFileSync('examples/row-groups-template.json','utf8'));
let app,processor,uploads,root;
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));const t=fixture(),f=t.sections[0].formats.meeting;
 const fields=f.inputSchema.fields.companies.items.fields.members.items.fields;fields.photo={type:'image'};fields.link={type:'link'};
 f.fragment.nodes.memberCell.childIds.push('photo');f.fragment.nodes.photo={id:'photo',type:'image',props:{width:{value:40,unit:'pt'},height:{value:20,unit:'pt'},source:{scope:'item',key:'photo'}}};
 f.fragment.nodes.memberText.children.push({id:'link',type:'field-ref',scope:'item',key:'link'});
 ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'v1'}));
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

const request=()=>JSON.parse(readFileSync('examples/row-groups-request.json','utf8'));
async function waitJob(id){let view;for(let i=0;i<400;i++){view=ok((await app.inject('/jobs/'+id)).json());if(['succeeded','failed'].includes(view.status))break;await new Promise(r=>setTimeout(r,25));}return view;}
it('returns nested input schemas without graphs and rejects invalid nested values before enqueue',async()=>{
 const r=request(),contract=ok((await app.inject('/templates/'+r.docKey+'/contract?version=1')).json());
 expect(contract.sections.main.formats.meeting.inputSchema.fields.companies.items.fields.members.items.fields.photo.type).toBe('image');expect(JSON.stringify(contract)).not.toContain('rowTemplateIds');
 const count=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 for(const members of [null,'wrong',[{name:123}],undefined]){const bad=request();bad.sections.main.content[0].data.companies[0]={name:'Company',...(members===undefined?{}:{members})};const res=await app.inject({method:'POST',url:'/jobs',payload:bad});expect(res.statusCode).toBe(422);expect(res.json().issues.some(i=>i.path.includes('companies[0].members'))).toBe(true);}
 expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(count);
});
it('returns an actionable client error for Core expansion limits without enqueueing',async()=>{
 const r=request();r.sections.main.content[0].data.companies=[{name:'Large',members:[{name:'x\n'.repeat(50001)}]}];
 const count=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 const res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode,res.body).toBe(422);expect(res.json().issues[0].code).toBe('EXPANSION_LIMIT');
 expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(count);
});
it('reloads nested prepared data, renders member images/links, and retains pinned published input',async()=>{
 for(const staged of [false,true]){
  const r=request();r.version=1;const members=r.sections.main.content[0].data.companies[0].members;
  for(const m of members)m.link={type:'link',text:'Reference',url:'https://example.com/member'};
  if(staged){const u=await upload();r.uploadId=u.uploadId;for(const m of members)m.photo=u.items[0].resourceId;}
  const res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode,res.body).toBe(202);const id=ok(res.json()).jobId;
  const view=await waitJob(id);expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+id+'/pdf');expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
  const bytes=pdf.rawPayload.toString('latin1');expect(bytes).toContain('/URI');if(staged)expect(bytes).toContain('/Subtype /Image');
  expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[id])).rows[0].original_input).toEqual(r);
 }
},30000);
it('supports empty arrays and refuses forged nested prepared values on worker reload',async()=>{
 for(const companies of [[],[{name:'Empty',members:[]}]]){const r=request();r.sections.main.content[0].data.companies=companies;const res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode,res.body).toBe(202);expect((await waitJob(ok(res.json()).jobId)).status).toBe('succeeded');}
 await processor.stop();processor=undefined;const r=request(),res=await app.inject({method:'POST',url:'/jobs',payload:r});expect(res.statusCode).toBe(202);const accepted=ok(res.json()).jobId;
 const path='{sections,main,content,0,data,companies,0,members,0,name}';
 await expect(db.pool.query('UPDATE generation_jobs SET prepared_input=jsonb_set(prepared_input,$1,$2) WHERE id=$3',[path,'"FORGED"',accepted])).rejects.toBeDefined();
 const id=(await db.pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) SELECT uuidv7(),template_version_id,original_input,jsonb_set(prepared_input,$1,$2),warnings_json,skipped_indices FROM generation_jobs WHERE id=$3 RETURNING id',[path,'"FORGED"',accepted])).rows[0].id;
 processor=await startProcessor({pool:db.pool,files:await createPdfFiles(join(root,'pdf')),policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:await createResourceFiles(join(root,'staging')),config:readUploadConfig({})}});
 expect((await waitJob(id)).status).toBe('failed');expect((await app.inject('/jobs/'+id+'/pdf')).statusCode).not.toBe(200);
},30000);
