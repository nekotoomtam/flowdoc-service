import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,saveCurrent,loadCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
let app,processor,root;
const template=JSON.parse(readFileSync('examples/contents-sections-template.json','utf8'));
beforeAll(async()=>{
 await db.setup();ok(await migrate(db.pool));root=await mkdtemp(join(tmpdir(),'contents-sections-api-'));
 const files=await createPdfFiles(root);processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24}});
 app=createServer({pool:db.pool,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady});
});
afterAll(async()=>{await app?.close();await processor?.stop();await db.close();if(root)await rm(root,{recursive:true,force:true});});
it('exports selected excluded headings as title-only links after published snapshot reload',async()=>{
 const current=ok(await importCurrent(db.pool,JSON.stringify(template)));
 const version=ok(await publishCurrent(db.pool,{templateId:template.templateId,requestId:'contents-1'}));
 current.sections.find(s=>s.key==='closing').payload.numbering={mode:'continue'};
 ok(await saveCurrent(db.pool,current,current.revision));
 const published=ok(await loadTemplate(db.pool,template.docKey,version.version)).template.definition;
 expect(published.sections.find(s=>s.key==='closing').numbering.mode).toBe('exclude');
 const payload=JSON.parse(readFileSync('examples/contents-sections-request.json','utf8'));payload.version=version.version;
 const response=await app.inject({method:'POST',url:'/jobs',payload});expect(response.statusCode,response.body).toBe(202);
 const id=ok(response.json()).jobId;let view;
 for(let n=0;n<600;n++){view=ok((await app.inject('/jobs/'+id)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+id+'/pdf');expect(pdf.statusCode).toBe(200);
 // Three title links, two counted number links; the excluded title still exists.
 expect((pdf.rawPayload.toString('latin1').match(/\/Dest \[/g)??[])).toHaveLength(5);
 expect(ok(await loadCurrent(db.pool,template.templateId)).revision).toBe(current.revision+1);
},30000);
