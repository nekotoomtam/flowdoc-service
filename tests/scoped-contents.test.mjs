import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createAuthoringTools} from '../dist/tools/authoring.js';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
const db=isolatedDatabase(),pool=db.pool,headers={authorization:'Bearer '+'s'.repeat(40)};
let app,root,processor,client,server;
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'scoped-contents-'));const files=await createPdfFiles(root);app=createServer({pool,isReady:()=>true,outputs:createOutputs(pool,files,24),authoring:{token:'s'.repeat(40),principal:'stage3'}});processor=await startProcessor({pool,files,policy:{retain:false,ttlHours:24,tempHours:24},pollMs:10});
 server=createAuthoringTools({baseUrl:'http://127.0.0.1:3000',token:'s'.repeat(40),fetch:async(url,init={})=>{const r=await app.inject({method:init.method??'GET',url:new URL(url).pathname,headers:init.headers,...(init.body?{payload:init.body}:{})});return new Response(r.rawPayload,{status:r.statusCode,headers:r.headers});}});client=new Client({name:'scoped-contents-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
});
afterAll(async()=>{await client?.close();await server?.close();await processor?.stop();await app?.close();await db.close();if(root)await rm(root,{recursive:true,force:true});});
const call=(method,url,payload)=>app.inject({method,url,headers,...(payload?{payload}:{})});
async function tool(name,args){const r=await client.callTool({name,arguments:args}),v=JSON.parse(r.content[0].text);expect(v.ok,JSON.stringify(v)).toBe(true);return v.value;}
async function preview(id,revision,sampleRequest,key){const r=await call('POST',`/authoring/drafts/${id}/previews`,{expectedRevision:revision,sampleRequest,idempotencyKey:key});expect(r.statusCode,r.body).toBe(202);const jobId=r.json().value.jobId;let status;for(let n=0;n<700;n++){status=(await call('GET','/authoring/previews/'+jobId)).json().value;if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}expect(status,JSON.stringify(status)).toMatchObject({status:'succeeded',revision,outputAvailable:true});const pdf=await call('GET','/authoring/previews/'+jobId+'/pdf');expect(pdf.statusCode).toBe(200);return {jobId,bytes:pdf.rawPayload};}
it('advertises scoped TOCs only in the Stage3 contract',async()=>{
 expect((await app.inject('/authoring/contract')).statusCode).toBe(401);
 expect((await call('GET','/authoring/contract')).json().value.sectionInstances).toEqual({model:19,input:'array-by-id',assembly:'saved-definition',stage:3,coverArea:true,scopedToc:true});
});
it('clones via native tool, reorders/edits independent data, and renders a pinned scoped preview',async()=>{
 const t=JSON.parse(readFileSync('tests/fixtures/scoped-contents/template.json')),r=JSON.parse(readFileSync('tests/fixtures/scoped-contents/request.json'));
 const identity=await tool('create_template_draft',{docKey:t.docKey,name:t.name,idempotencyKey:'create'});t.templateId=identity.templateId;
 await tool('update_template_draft',{templateId:t.templateId,expectedRevision:0,definition:t,idempotencyKey:'save'});
 const original=await preview(t.templateId,1,r,'original');
 const clone=await tool('clone_template_draft',{templateId:t.templateId,sourceRevision:1,docKey:t.docKey+'-clone',name:'Cloned scoped document',idempotencyKey:'clone'});
 expect(Object.keys(clone.sectionIdMap)).toEqual(t.sections.map(s=>s.id));expect(clone.definition.sections.every(s=>!t.sections.some(o=>o.id===s.id))).toBe(true);
 const definition=clone.definition;definition.sections.reverse();const sample=structuredClone(r);sample.docKey=definition.docKey;
 for(const s of sample.sections){s.id=clone.sectionIdMap[s.id];s.data.label='Clone'+s.data.label;s.data.parts.find(p=>p.format==='prose').data.text='Edited cloned body\nรายละเอียดที่แก้เฉพาะสำเนา';}
 await tool('update_template_draft',{templateId:definition.templateId,expectedRevision:1,definition,idempotencyKey:'edit'});
 const rendered=await preview(definition.templateId,2,sample,'clone-preview');
 const pinned=(await pool.query('SELECT prepared_input,preview_definition FROM generation_jobs WHERE id=$1',[rendered.jobId])).rows[0];expect(pinned.prepared_input.schemaVersion).toBe(2);expect(pinned.preview_definition.sections.map(s=>s.id)).toEqual(definition.sections.map(s=>s.id));
 const source=await tool('get_template_draft',{templateId:t.templateId});expect(source.definition).toEqual(t);expect(source.revision).toBe(1);
 expect((await call('GET','/authoring/previews/'+original.jobId+'/pdf')).rawPayload.equals(original.bytes)).toBe(true);
 const bad=structuredClone(definition);const f=Object.values(bad.areaFormats).find(f=>f.key==='section-contents');f.fragment.nodes.toc.props.scope.kind='document';const invalid=await call('POST','/authoring/validate',{definition:bad,sampleRequest:sample});expect(invalid.statusCode,invalid.body).toBe(422);
 expect((await pool.query('SELECT count(*) FROM template_versions')).rows[0].count).toBe('0');
 if(process.env.STAGE3_PDF_OUTPUT_DIR){const out=process.env.STAGE3_PDF_OUTPUT_DIR;await mkdir(out,{recursive:true});await writeFile(join(out,'scoped-contents-clone.pdf'),rendered.bytes);await writeFile(join(out,'scoped-contents-clone.template.json'),JSON.stringify(definition,null,2));await writeFile(join(out,'scoped-contents-clone.request.json'),JSON.stringify(sample,null,2));await writeFile(join(out,'service-clone-result.json'),JSON.stringify({status:'PASS',sourceId:t.templateId,cloneId:definition.templateId,sectionIdMap:clone.sectionIdMap,sourcePdfBytes:original.bytes.length,clonePdfBytes:rendered.bytes.length},null,2));}
},45000);
