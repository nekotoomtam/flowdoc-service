import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate,registerTemplate} from '../dist/templates/registry.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let app,processor;
const template=JSON.parse(readFileSync('examples/merged-template.json','utf8'));
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));const files=await createPdfFiles(await mkdtemp(join(tmpdir(),'merged-api-')));processor=await startProcessor({pool:db.pool,files,policy:{retain:true,ttlHours:24,tempHours:24}});app=createServer({pool:db.pool,outputs:createOutputs(db.pool,files,24),isReady:processor.isReady});});
afterAll(async()=>{await app?.close();await processor?.stop();await db.close();});
it('publishes model 6 and exports merged cells through the job API',async()=>{
 ok(await importCurrent(db.pool,JSON.stringify(template)));const version=ok(await publishCurrent(db.pool,{templateId:template.templateId,requestId:'merged-1'}));
 expect(ok(await loadTemplate(db.pool,template.docKey,version.version)).template.definition.nodeModelVersion).toBe(6);
 const response=await app.inject({method:'POST',url:'/jobs',payload:{docKey:template.docKey,version:version.version,data:{text:Array.from({length:70},(_,i)=>'ROW-'+i+' ข้อมูล').join('\n')},content:[{format:'merged',data:{}}]}});
 expect(response.statusCode).toBe(202);const id=ok(response.json()).jobId;let view;
 for(let n=0;n<600;n++){view=ok((await app.inject('/jobs/'+id)).json());if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,20));}
 expect(view.status,JSON.stringify(view)).toBe('succeeded');const pdf=await app.inject('/jobs/'+id+'/pdf');expect(pdf.statusCode).toBe(200);expect(pdf.rawPayload.toString('latin1')).toContain('%PDF-');
 ok(await registerTemplate(db.pool,readFileSync('examples/srs-template.json','utf8')));expect(ok(await loadTemplate(db.pool,'srs-table-trial',1)).template.definition.nodeModelVersion).toBe(4);
},30000);
it('rejects overlapping grids before publication or job insertion',async()=>{const bad=structuredClone(template);bad.templateId=bad.docKey='bad-merged';bad.formats.merged.fragment.nodes.e.props.columnIndex=0;expect((await importCurrent(db.pool,JSON.stringify(bad))).ok).toBe(false);const r=await app.inject({method:'POST',url:'/jobs',payload:{docKey:'bad-merged',data:{text:'x'},content:[{format:'merged',data:{}}]}});expect(r.statusCode).not.toBe(202);expect((await db.pool.query("SELECT 1 FROM templates WHERE doc_key='bad-merged'")).rowCount).toBe(0);});
