import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),read=n=>JSON.parse(readFileSync('examples/area-document-'+n+'.json','utf8'));
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let app;
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));const t=read('template');ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'area-v18'}));app=createServer({pool:db.pool,outputs:{available:async()=>false},isReady:()=>true,imagesEnabled:true});});
afterAll(async()=>{await app?.close();await db.close();});
it('persists model18 section variables and owned formats in immutable snapshots',async()=>{
 const t=read('template'),loaded=ok(await loadTemplate(db.pool,t.docKey,1));
 expect(loaded.template.definition).toMatchObject({nodeModelVersion:18});
 const c=ok((await app.inject('/templates/'+t.docKey+'/contract?version=1')).json());
 expect(c.sections.main.inputSchema.fields.details.type).toBe('area');
 expect(c.sections.main.formats).toEqual({});expect(c.areaFormats.meeting.ownerAreaId).toBe('main-details');
});
it('enqueues section Area data and rejects malformed entries without partial jobs',async()=>{
 const good=await app.inject({method:'POST',url:'/jobs',payload:read('request')});expect(good.statusCode,good.body).toBe(202);
 const count=(await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 for(const entry of [{format:'wrong',data:{}},{format:'meeting',data:{}},{format:'meeting',data:{companies:'wrong'}}]){
  const r=read('request');r.sections.main.data.details.push(entry);
  const out=await app.inject({method:'POST',url:'/jobs',payload:r});expect(out.statusCode,out.body).toBe(422);
  expect(out.json().issues.some(i=>i.path.startsWith('sections.main.data.details[1]'))).toBe(true);
 }
 expect((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(count);
 const r=read('request');r.sections.main.content=[];expect((await app.inject({method:'POST',url:'/jobs',payload:r})).statusCode).toBe(422);
});
