import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent} from '../dist/templates/current.js';
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
let app,processor,uploads,version;
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));
 const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
 t.templateId=t.docKey='cell-content';t.nodeModelVersion=9;t.examples=[];t.globalSchema={type:'object',fields:{}};
 const text=(id,key)=>({id,type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:id+'-field',type:'field-ref',scope:'local',key}]});
 t.formats={evidence:{inputSchema:{type:'object',fields:{description:{type:'string',required:true},photo:{type:'image',required:true},caption:{type:'string',required:true}}},repeats:[],fragment:{rootIds:['table'],nodes:{
  table:{id:'table',type:'table',props:{headerRowCount:0,repeatHeaderRows:false},columns:[{width:{value:440,unit:'pt'}}],rowIds:['row']},
  row:{id:'row',type:'table-row',props:{allowBreak:true},cellIds:['cell']},
  cell:{id:'cell',type:'table-cell',props:{padding:{left:{value:0,unit:'pt'},top:{value:2,unit:'mm'}}},childIds:['description','image','caption']},
  description:text('description','description'),caption:text('caption','caption'),
  image:{id:'image',type:'image',props:{width:{value:180,unit:'pt'},height:{value:100,unit:'pt'},align:'right',source:{scope:'local',key:'photo'}}}
 }}}};
 ok(await importCurrent(db.pool,JSON.stringify(t)));version=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'cell-v1'})).version;
 const root=await mkdtemp(join(tmpdir(),'cell-api-')),resources=await createResourceFiles(join(root,'staging')),files=await createPdfFiles(join(root,'pdf')),config=readUploadConfig({});
 uploads=createUploads({pool:db.pool,files:resources,config});processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files:resources,config}});
 app=createServer({pool:db.pool,uploads,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady,imagesEnabled:true});
});
afterAll(async()=>{await app?.close();await processor?.stop();await uploads?.stop();await db.close();});
it('publishes model 9, claims cell images, prepares them and downloads PDF with bad-image warning',async()=>{
 expect(ok(await loadTemplate(db.pool,'cell-content',version)).template.definition.nodeModelVersion).toBe(9);
 const bytes=[await sharp({create:{width:800,height:400,channels:3,background:'#2870a0'}}).jpeg().toBuffer(),Buffer.from('bad-image')];
 const upload=ok((await app.inject({method:'POST',url:'/uploads',payload:{requestKey:'cell-proof',items:bytes.map((b,i)=>({key:'p'+i,source:'upload',mediaType:'image/jpeg',byteSize:b.length}))}})).json());
 for(let i=0;i<bytes.length;i++)expect((await app.inject({method:'PUT',url:`/uploads/${upload.uploadId}/items/${upload.items[i].resourceId}/content`,headers:{'content-type':'application/octet-stream'},payload:bytes[i]})).statusCode).toBe(200);
 ok((await app.inject({method:'POST',url:`/uploads/${upload.uploadId}/finalize`})).json());
 const request={docKey:'cell-content',version,uploadId:upload.uploadId,data:{},content:[0,1].map(i=>({format:'evidence',data:{description:'ทดสอบข้อความในเซลล์\n'.repeat(50),photo:upload.items[i].resourceId,caption:'คำบรรยาย '+i}}))};
 const submitted=await app.inject({method:'POST',url:'/jobs',payload:request});expect(submitted.statusCode,submitted.body).toBe(202);const job=ok(submitted.json());
 let view;for(let i=0;i<900;i++){view=ok((await app.inject('/jobs/'+job.jobId)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');expect(view.processing).toMatchObject({stage:'complete',completed:2,total:2});expect(view.warnings.some(w=>w.code==='IMAGE_UNUSABLE')).toBe(true);
 const pdf=await app.inject(`/jobs/${job.jobId}/pdf`);expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.toString('latin1')).toContain('/Subtype /Image');
 expect((await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0].original_input).toEqual(request);
},60000);
