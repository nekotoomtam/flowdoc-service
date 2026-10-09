import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {createServer} from '../dist/http/server.js';
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
