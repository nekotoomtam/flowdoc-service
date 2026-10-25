import {it,expect,beforeAll,beforeEach,afterAll} from 'vitest';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,response,artifact,auth,body,contentType} from './taskDocxFixture.mjs';
const f=fixture();beforeAll(()=>f.setup());beforeEach(()=>f.reset());afterAll(()=>f.close());
it.each(['pdf','docx'])('creates and sends a real %s through installed Core and the child process',async format=>{
 const id=await f.task(format,3),out=response(),result=await f.manager.execute({authorization:auth,taskId:id,response:out}).catch(async e=>{throw Error(JSON.stringify({code:e.code,task:await f.intake.inspect(auth,id)}));});expect(result.status).toBe('succeeded');const file=artifact(out.parts),job=(await f.pool.query('SELECT * FROM generation_jobs WHERE task_id=$1',[id])).rows[0],stored=(await f.pool.query('SELECT * FROM document_outputs WHERE job_id=$1',[job.id])).rows[0];
 expect(stored.output_format).toBe(format);expect(Number(stored.byte_size)).toBe(file.bytes.length);expect(stored.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));expect(file.headers).toContain('filename="document.'+format+'"');
 if(format==='docx'){
  expect(stored.page_count).toBe(null);expect(file.bytes.subarray(0,2).toString()).toBe('PK');const xml=spawnSync('python',['-c',"import sys,zipfile,io,json,xml.etree.ElementTree as E;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print(json.dumps({'text':''.join(E.fromstring(z.read('word/document.xml')).itertext()),'images':[n for n in z.namelist() if n.startswith('word/media/')],'fonts':[n for n in z.namelist() if n.endswith('.odttf')]}))"],{input:file.bytes,encoding:'utf8'});expect(xml.status,xml.stderr).toBe(0);const packageContent=JSON.parse(xml.stdout);expect(packageContent.text).toContain('ไทย EN');expect(packageContent.images.length).toBeGreaterThan(0);expect(packageContent.fonts.length).toBeGreaterThan(0);expect(Buffer.concat(out.parts).toString()).toContain('"buffered":true');
 }else{expect(stored.page_count).toBeGreaterThan(0);expect(file.bytes.subarray(0,5).toString()).toBe('%PDF-');}
 await f.save('child-small.'+format,file.bytes);expect((await f.intake.inspect(auth,id)).outputFormat).toBe(format);
},30000);
it.each([false,true])('delivers real DOCX through HTTP, queue=%s',async queue=>{
 const url=await f.server(),r=await fetch(url+'/documents',{method:'POST',headers:{authorization:auth,'doc-key':'docx-small','content-type':contentType,'output-format':'DOCX',...(queue?{'task-mode':'queue-v1'}:{})},body:await body(2)});expect(r.status).toBe(200);const parts=[Buffer.from(await r.arrayBuffer())],file=artifact(parts);expect(file.bytes.subarray(0,2).toString()).toBe('PK');expect(file.headers).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');await f.save('http-'+(queue?'queue':'normal')+'.docx',file.bytes);
},30000);

it('exports the previously unsupported mixed Thai/English relation as real DOCX without a PDF fallback',async()=>{
 const id=await f.task('docx',1,false,'ภาษาไทย Mixed English'),out=response();
 const result=await f.manager.execute({authorization:auth,taskId:id,response:out});expect(result.status).toBe('succeeded');
 const file=artifact(out.parts);expect(file.bytes.subarray(0,2).toString()).toBe('PK');expect(file.headers).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
 const xml=spawnSync('python',['-c',"import sys,zipfile,io,xml.etree.ElementTree as E;z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));print(''.join(E.fromstring(z.read('word/document.xml')).itertext()))"],{input:file.bytes,encoding:'utf8'});
 expect(xml.status,xml.stderr).toBe(0);expect(xml.stdout).toContain('ภาษาไทย Mixed English');
 const stored=(await f.pool.query('SELECT o.* FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1',[id])).rows;expect(stored).toHaveLength(1);expect(stored[0].output_format).toBe('docx');expect(stored[0].page_count).toBe(null);
 await f.save('supported-mixed-relation.docx',file.bytes);
},30000);

it('reports unavailable image placements as an explicit DOCX capability limit',async()=>{
 const id=await f.task('docx',0),out=response();await expect(f.manager.execute({authorization:auth,taskId:id,response:out})).rejects.toHaveProperty('code','DOCX_CAPABILITY_UNSUPPORTED');expect(Buffer.concat(out.parts).toString()).toContain('DOCX_UNSUPPORTED');
},30000);
