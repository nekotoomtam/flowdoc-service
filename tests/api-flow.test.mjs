import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),pool=db.pool;let app,processor,url;
const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);const files=await createPdfFiles(await mkdtemp(join(tmpdir(),'flowdoc-api-')));const outputs=createOutputs(pool,files,24);processor=await startProcessor({pool,files,policy:{retain:false,ttlHours:24,tempHours:24}});app=createServer({pool,outputs,isReady:processor.isReady});url=await app.listen({host:'127.0.0.1',port:0});});
afterAll(async()=>{await app?.close();await processor?.stop();await db.close();});
it('exports three distinct real PDFs over HTTP and consumes each default result',async()=>{
 const ids=[];
 for(let i=0;i<3;i++){const r=await fetch(url+'/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,data:{projectName:'Project '+i},content:[...input.content,{format:'missing',data:{}}]})});expect(r.status).toBe(202);ids.push((await r.json()).value.jobId);}
 const pdfs=[];
 for(const id of ids){let view;for(let n=0;n<300;n++){view=await (await fetch(url+'/jobs/'+id)).json();if(['failed','succeeded'].includes(view.value.status))break;await new Promise(r=>setTimeout(r,20));}expect(view.value.status,JSON.stringify(view)).toBe('succeeded');expect(view.value.hasWarnings).toBe(true);const download=await fetch(url+view.value.downloadUrl);expect(download.status).toBe(200);const bytes=Buffer.from(await download.arrayBuffer());expect(bytes.subarray(0,5).toString()).toBe('%PDF-');pdfs.push(bytes);for(let n=0;n<100;n++){if(!(await (await fetch(url+'/jobs/'+id)).json()).value.outputAvailable)break;await new Promise(r=>setTimeout(r,10));}expect((await fetch(url+'/jobs/'+id+'/pdf')).status).toBe(410);}
 expect(pdfs[0].equals(pdfs[1])).toBe(false);expect(pdfs[1].equals(pdfs[2])).toBe(false);
},60000);
