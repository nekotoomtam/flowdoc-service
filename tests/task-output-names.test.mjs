import {beforeAll,afterAll,it,expect} from 'vitest';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {fixture,template,auth,sid,contentType,artifact,response} from './taskDocxFixture.mjs';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
import {createAuthoring} from '../dist/authoring/service.js';
const definition=template();definition.areaFormats.item.fragment.rootIds=['text'];delete definition.areaFormats.item.fragment.nodes.photo;definition.defaultFileName='ตั้งต้น CLIS';
const f=fixture(definition);let url;
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
function body(extra={}){return Buffer.from('--docx-fixture\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({...extra,data:{},sections:[{id:sid,data:{parts:[{format:'item',data:{text:'ชื่อไฟล์ ไทย EN'}}]}}]})+'\r\n--docx-fixture--\r\n');}
beforeAll(async()=>{await f.setup();await f.reset();url=await f.server();},30000);
afterAll(()=>f.close());
for(const format of ['pdf','docx'])for(const [label,extra,name] of [['override',{fileName:'  รายงาน CLIS  '},'รายงาน CLIS'],['default',{},'ตั้งต้น CLIS'],['blank',{fileName:'  '},'ตั้งต้น CLIS']])it(format+' '+label+' delivers named real bytes and exposes the frozen base name',async()=>{
 const r=await fetch(url+'/documents',{method:'POST',headers:{authorization:auth,'doc-key':'docx-small','content-type':contentType,'output-format':format,...(label==='blank'?{'task-mode':'queue-v1'}:{})},body:body(extra)});
 expect(r.status).toBe(200);const all=Buffer.from(await r.arrayBuffer()),file=artifact([all]);
 expect(file.headers).toContain("filename*=UTF-8''"+encodeURIComponent(name+'.'+format));
 expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');
 const id=all.toString().match(/"taskId":"([^"]+)"/)[1];
 const stored=(await f.pool.query('SELECT t.file_name,o.sha256,o.page_count FROM tasks t JOIN generation_jobs j ON j.task_id=t.id JOIN document_outputs o ON o.job_id=j.id WHERE t.id=$1',[id])).rows[0];
 expect(stored.file_name).toBe(name);expect(stored.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));expect(format==='pdf'?Number(stored.page_count)>0:stored.page_count===null).toBe(true);
 const lookup=await fetch(url+'/documents',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({taskId:id})});const status=await lookup.json();
 expect(status.task).toMatchObject({fileName:name,output:{fileName:name,outputFormat:format}});
 await f.save('filename-'+label+'.'+format,file.bytes);
},30000);
it('freezes a queued default before template replacement and rejects name mutation',async()=>{
 const task=await f.intake.open({authorization:auth,docKey:'docx-small',contentType,outputFormat:'pdf',queueMode:true});
 const next=structuredClone(definition);next.version=2;next.defaultFileName='ค่าใหม่';ok(await registerTemplate(f.pool,JSON.stringify(next)));
 await f.intake.receive({authorization:auth,taskId:task.taskId,contentType,body:Readable.from([body()])});
 expect((await f.intake.inspect(auth,task.taskId)).fileName).toBe('ตั้งต้น CLIS');
 for(const column of ['file_name','default_file_name'])await expect(f.pool.query('UPDATE tasks SET '+column+'=$2 WHERE id=$1',[task.taskId,'changed'])).rejects.toHaveProperty('code','55000');
 await f.intake.normalize({authorization:auth,taskId:task.taskId});
 const out=response();expect((await f.manager.execute({authorization:auth,taskId:task.taskId,response:out})).status).toBe('succeeded');expect(artifact(out.parts).headers).toContain("filename*=UTF-8''"+encodeURIComponent('ตั้งต้น CLIS.pdf'));
},30000);
it('legacy template with no default still returns document.pdf',async()=>{
 const old=template();old.version=3;ok(await registerTemplate(f.pool,JSON.stringify(old)));
 const r=await fetch(url+'/documents',{method:'POST',headers:{authorization:auth,'doc-key':'docx-small','content-type':contentType},body:body()});expect(r.status).toBe(200);
 expect(artifact([Buffer.from(await r.arrayBuffer())]).headers).toContain('filename="document.pdf"');
},30000);
it('invalid root names fail the real intake without producing output',async()=>{
 for(const value of ['../bad',null]){
  const t=await f.intake.open({authorization:auth,docKey:'docx-small',contentType});
  await expect(f.intake.receive({authorization:auth,taskId:t.taskId,contentType,body:Readable.from([body({fileName:value})])})).rejects.toHaveProperty('code','INVALID_REQUEST');
  expect((await f.pool.query('SELECT count(*) FROM generation_jobs WHERE task_id=$1',[t.taskId])).rows[0].count).toBe('0');
 }
});
it('authoring save/read/clone and immutable registry versions retain the default',async()=>{
 const a=createAuthoring(f.pool,'name-author',{maxOutstanding:10,imagesEnabled:false});
 const created=ok(await a.create({name:'Named report',docKey:'named-authoring',idempotencyKey:'create'}));
 const t=template();t.templateId=created.templateId;t.docKey='named-authoring';t.defaultFileName='ชื่อรายงาน';
 const saved=ok(await a.save(created.templateId,{definition:t,expectedRevision:0,idempotencyKey:'save'}));expect(saved.definition.defaultFileName).toBe(t.defaultFileName);
 expect(ok(await a.get(created.templateId)).definition.defaultFileName).toBe(t.defaultFileName);
 expect(ok(await a.cloneDraft(created.templateId,{sourceRevision:1,name:'Clone',docKey:'named-clone',idempotencyKey:'clone'})).definition.defaultFileName).toBe(t.defaultFileName);
 // Registry publication is exercised only inside this disposable schema.
 ok(await registerTemplate(f.pool,JSON.stringify(saved.definition)));
 const loaded=ok(await loadTemplate(f.pool,'named-authoring'));expect(loaded.template.definition.defaultFileName).toBe(t.defaultFileName);
});
