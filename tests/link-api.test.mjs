import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate,registerTemplate} from '../dist/templates/registry.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let app,processor;
const template=JSON.parse(readFileSync('examples/links-template.json','utf8'));
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));const files=await createPdfFiles(await mkdtemp(join(tmpdir(),'links-api-')));processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24}});app=createServer({pool:db.pool,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady});});
afterAll(async()=>{await app?.close();await processor?.stop();await db.close();});

it('publishes isolated link variables and exports forward/backward destinations through the API',async()=>{
 expect((await db.pool.query('SELECT code FROM variable_types WHERE id=110005')).rows).toEqual([{code:'link'}]);
 const current=ok(await importCurrent(db.pool,JSON.stringify(template)));const version=ok(await publishCurrent(db.pool,{templateId:template.templateId,requestId:'links-1'}));
 const link=current.variables.find(v=>v.typeId===110005);link.payload.default={type:'url',value:'https://example.org'};ok(await saveCurrent(db.pool,current,current.revision));
 const published=ok(await loadTemplate(db.pool,template.docKey,version.version));expect(published.template.definition.globalSchema.fields.website.default.value).toBe('https://example.com');
 const payload={docKey:template.docKey,version:version.version,data:{},content:[{format:'section',data:{anchor:'start',target:'end',heading:'FIRST',body:'line\n'.repeat(60)}},{format:'section',data:{anchor:'end',target:'start',heading:'LAST'}}]};
 const response=await app.inject({method:'POST',url:'/jobs',payload});expect(response.statusCode).toBe(202);const id=ok(response.json()).jobId;let view;
 for(let n=0;n<1000;n++){view=ok((await app.inject('/jobs/'+id)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+id+'/pdf');expect(pdf.statusCode).toBe(200);const text=pdf.rawPayload.toString('latin1');expect((text.match(/\/Subtype \/Link/g)??[]).length).toBeGreaterThanOrEqual(6);expect(text).toContain('/Dest [5 0 R /XYZ');expect(text).toContain('/Dest [3 0 R /XYZ');
 ok(await registerTemplate(db.pool,readFileSync('examples/srs-template.json','utf8')));expect(ok(await loadTemplate(db.pool,'srs-table-trial',1)).template.definition.nodeModelVersion).toBe(4);
},45000);
it('rejects invalid link publication and missing destination before successful export',async()=>{const bad=structuredClone(template);bad.templateId=bad.docKey='bad-link';bad.globalSchema.fields.website.default={type:'url',value:'javascript:alert(1)'};expect((await importCurrent(db.pool,JSON.stringify(bad))).ok).toBe(false);expect((await db.pool.query("SELECT 1 FROM templates WHERE doc_key='bad-link'")).rowCount).toBe(0);const r=await app.inject({method:'POST',url:'/jobs',payload:{docKey:template.docKey,data:{website:{type:'reference',text:'go',target:'missing'}},content:[{format:'section',data:{anchor:'a',target:'a',heading:'A'}}]}});if(r.statusCode===202){const id=ok(r.json()).jobId;let view;for(let n=0;n<500;n++){view=ok((await app.inject('/jobs/'+id)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}expect(view.status).toBe('failed');}else expect(r.statusCode).toBeGreaterThanOrEqual(400);});
