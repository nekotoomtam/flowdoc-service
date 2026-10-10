import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {createServer} from '../dist/http/server.js';
import {startProcessor} from '../dist/jobs/processor.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let app;
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));const t=JSON.parse(readFileSync('examples/area-template.json','utf8'));ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'one'}));app=createServer({pool:db.pool,outputs:{available:async()=>false},isReady:()=>true,imagesEnabled:true});});afterAll(async()=>{await app?.close();await db.close();});
const req=details=>({docKey:'area-demo',version:1,data:{},content:[{format:'evidence',data:{details}}]});
it('returns owned area input contract without node graph',async()=>{const r=ok((await app.inject('/templates/area-demo/contract?version=1')).json());expect(r.areaFormats['format-001']).toMatchObject({ownerAreaId:'area-001',key:'evidence'});expect(r.areaFormats['format-001'].fragment).toBeUndefined();expect(r.areaFormats['format-002'].inputSchema.fields).toEqual({});});
it('rejects raw duplicate decoded keys before enqueue',async()=>{for(const raw of ['{"docKey":"wrong","docKey":"area-demo","content":[]}','{"docKey":"wrong","\\u0064ocKey":"area-demo","content":[]}']){const r=await app.inject({method:'POST',url:'/jobs',headers:{'content-type':'application/json'},payload:raw});expect(r.statusCode).toBe(400);}expect(Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count)).toBe(0);});
it('queues all-skipped areas with warnings and preserves original data',async()=>{const input=req([{format:'missing',data:{}},{format:'evidence',data:{photo:'22222222-2222-4222-8222-222222222222'}}]);const r=await app.inject({method:'POST',url:'/jobs',payload:input});expect(r.statusCode,r.body).toBe(202);const job=ok(r.json());expect(job.warnings.map(w=>w.path)).toEqual(['content[0].data.details[0].format','content[0].data.details[1].data.caption']);const row=(await db.pool.query('SELECT original_input FROM generation_jobs WHERE id=$1',[job.jobId])).rows[0];expect(row.original_input).toEqual(input);});
it('rejects outer wrong type and accepts static content without upload',async()=>{expect((await app.inject({method:'POST',url:'/jobs',payload:req('bad')})).statusCode).toBe(422);expect((await app.inject({method:'POST',url:'/jobs',payload:req([{format:'notice',data:{}}])})).statusCode).toBe(202);});

it('rejects malformed, oversized and prototype JSON',async()=>{
 for(const payload of ['{','{"__proto__":{"polluted":true}}','{"constructor":{"prototype":{"polluted":true}}}'])expect((await app.inject({method:'POST',url:'/jobs',headers:{'content-type':'application/json'},payload})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/jobs',headers:{'content-type':'application/json'},payload:JSON.stringify({x:'x'.repeat(2097152)})})).statusCode).toBe(413);
});

it('skips wrong-type entry data without rejecting the surrounding document',async()=>{
 const r=await app.inject({method:'POST',url:'/jobs',payload:req([{format:'evidence',data:{photo:'22222222-2222-4222-8222-222222222222',caption:3}},{format:'notice',data:{}}])});
 expect(r.statusCode,r.body).toBe(202);expect(ok(r.json()).warnings[0]).toMatchObject({code:'AREA_ENTRY_SKIPPED',expectedType:'string',actualType:'number'});
});

it('rejects coordinated prepared changes against preserved admission input before rendering',async()=>{
 const validReceipt=ok((await app.inject({method:'POST',url:'/jobs',payload:req([{format:'notice',data:{zzz:1,a:2}}])})).json());
 const receipt=ok((await app.inject({method:'POST',url:'/jobs',payload:req([{format:'missing',data:{}}])})).json());
 const stored=(await db.pool.query('SELECT prepared_input FROM generation_jobs WHERE id=$1',[receipt.jobId])).rows[0].prepared_input;
 stored.content[0].data.details.entries=[{originalIndex:0,format:'notice',formatId:'format-002',data:{}}];stored.content[0].data.details.skippedIndices=[];stored.warnings=[];
 const forgedId=(await db.pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) SELECT uuidv7(),template_version_id,original_input,$2,$3,skipped_indices FROM generation_jobs WHERE id=$1 RETURNING id',[receipt.jobId,JSON.stringify(stored),'[]'])).rows[0].id;

 const processor=await startProcessor({pool:db.pool,policy:{retain:false,ttlHours:24,tempHours:24},pollMs:5,files:{writePdf:async id=>({path:id+'.pdf',byteSize:4})},render:async()=>{return {ok:true,value:{bytes:Buffer.from('%PDF'),mediaType:'application/pdf'},warnings:[]};}});
 try{let status;for(let i=0;i<200;i++){status=(await db.pool.query('SELECT status FROM generation_jobs WHERE id=$1',[forgedId])).rows[0].status;if(['failed','succeeded'].includes(status))break;await new Promise(r=>setTimeout(r,10));}expect(status).toBe('failed');expect((await db.pool.query('SELECT 1 FROM document_outputs WHERE job_id=$1',[forgedId])).rowCount).toBe(0);expect((await db.pool.query('SELECT status FROM generation_jobs WHERE id=$1',[validReceipt.jobId])).rows[0].status).toBe('succeeded');}
 finally{await processor.stop();}
});
