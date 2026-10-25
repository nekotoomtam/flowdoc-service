import {it,expect,beforeAll,afterAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createTaskIntake} from '../dist/tasks/intake.js';
import {createServer} from '../dist/http/server.js';
const formats=await import('../dist/tasks/output-format.js').catch(()=>({}));
it.each([[undefined,'pdf'],[[],'pdf'],['PDF','pdf'],['pdf','pdf'],['DOCX','docx'],[' DocX\t','docx'],[['PDF'],'pdf']])('normalizes header %j to %s',(value,expected)=>{expect(formats.parseOutputFormat).toBeTypeOf('function');expect(formats.parseOutputFormat(value)).toBe(expected);});
it.each(['',' ','txt','pdf,docx','pdf,pdf',null,42,['PDF','PDF'],['pdf','docx']])('rejects invalid/duplicate header %j',value=>{expect(formats.parseOutputFormat).toBeTypeOf('function');expect(()=>formats.parseOutputFormat(value)).toThrowError(expect.objectContaining({code:'INVALID_REQUEST'}));});
const db=isolatedDatabase(),pool=db.pool,auth='Bearer '+'f'.repeat(40),contentType='multipart/form-data; boundary=format-test';let intake,root,app;
function smallTemplate(){const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.nodeModelVersion=18;t.templateId=t.docKey='format-small';t.examples=[];t.globalSchema={type:'object',fields:{}};delete t.areaFormats;t.sections=[{id:'main',key:'main',formats:{},inputSchema:{type:'object',fields:{}},source:{kind:'authored',repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'text',text:'Small ไทย'}]}}}}}];return t;}
const identity=h=>h===auth?{ownerKey:'owner',principalId:'creator',taskRead:true,docKeys:['format-small']}:null;
const multipart=()=>Buffer.from('--format-test\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n{"data":{},"sections":{}}\r\n--format-test--\r\n');
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,JSON.stringify(smallTemplate()))).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'format-i4-'));intake=await createTaskIntake({pool,root,resolveCredential:identity,policy:{maxTasks:10,maxOwnerTasks:10,maxOutstanding:20},freeBytes:async()=>20_000_000_000});app=createServer({pool,outputs:{},isReady:()=>true,tasks:{intake,processing:{execute:async()=>{throw Object.assign(Error('not connected'),{code:'UNAVAILABLE'});}}}});});
afterAll(async()=>{await app?.close();await intake?.stop();await db.close();});
it.each([undefined,'PDF','dOcX'])('persists new-task format %s and version2 envelope without changing business input',async outputFormat=>{
 const t=await intake.open({authorization:auth,docKey:'format-small',contentType,...(outputFormat!==undefined?{outputFormat}:{})});const expected=outputFormat?.toLowerCase()??'pdf';expect(t.outputFormat).toBe(expected);
 await intake.receive({authorization:auth,taskId:t.taskId,contentType,body:Readable.from([multipart()])});await intake.normalize({authorization:auth,taskId:t.taskId});
 const r=(await pool.query('SELECT * FROM tasks WHERE id=$1',[t.taskId])).rows[0];expect(r).toMatchObject({output_format:expected,normalization_version:2});
 const f=(await pool.query('SELECT storage_key FROM task_files WHERE id=$1',[r.normalized_file_id])).rows[0],envelope=JSON.parse(await readFile(join(root,f.storage_key),'utf8'));expect(envelope).toMatchObject({version:2,outputFormat:expected,summary:{outputFormat:expected,normalizationVersion:2}});expect(envelope.input).not.toHaveProperty('outputFormat');
 await expect(pool.query("UPDATE tasks SET output_format=$2 WHERE id=$1",[t.taskId,expected==='pdf'?'docx':'pdf'])).rejects.toHaveProperty('code','55000');
});
it('rejects bad headers before durable allocation and authenticates first',async()=>{
 const before=Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count);
 for(const value of ['',null,'png',['PDF','PDF']])await expect(intake.open({authorization:auth,docKey:'format-small',contentType,outputFormat:value})).rejects.toHaveProperty('code','INVALID_REQUEST');
 await expect(intake.open({authorization:'bad',docKey:'format-small',contentType,outputFormat:'png'})).rejects.toHaveProperty('code','UNAUTHORIZED');expect(Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count)).toBe(before);
});
it('rejects raw duplicate HTTP headers and format selection on lookup',async()=>{
 const before=Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count);
 const r=await app.inject({method:'POST',url:'/documents',headers:{authorization:auth,'doc-key':'format-small','content-type':contentType,'output-format':['PDF','PDF']},payload:multipart()});expect(r.statusCode).toBe(400);expect(Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count)).toBe(before);
 const task=await intake.open({authorization:auth,docKey:'format-small',contentType});const q=await app.inject({method:'POST',url:'/documents',headers:{authorization:auth,'content-type':'application/json','output-format':'PDF'},payload:JSON.stringify({taskId:task.taskId})});expect(q.statusCode).toBe(409);
});

it('verifies historical and current envelope versions and rejects format/version tampering',()=>{
 expect(formats.verifyEnvelopeFormat).toBeTypeOf('function');
 expect(formats.verifyEnvelopeFormat(1,undefined,1,'pdf')).toBe('pdf');
 for(const f of ['pdf','docx'])expect(formats.verifyEnvelopeFormat(2,f,2,f)).toBe(f);
 for(const args of [[undefined,undefined,1,'pdf'],[1,'pdf',1,'pdf'],[1,undefined,1,'docx'],[2,'docx',2,'pdf'],[2,undefined,2,'docx'],[3,'pdf',3,'pdf'],[1,undefined,2,'pdf']])expect(()=>formats.verifyEnvelopeFormat(...args)).toThrowError(expect.objectContaining({code:'INPUT_INTEGRITY'}));
});
it.each([[undefined,'pdf'],['PDF','pdf'],[' dOcX ','docx']])('accepts HTTP format %s in normal and queue modes',async(value,expected)=>{
 for(const queue of [false,true]){
  const headers={authorization:auth,'doc-key':'format-small','content-type':contentType,...(queue?{'task-mode':'queue-v1'}:{}),...(value===undefined?{}:{'output-format':value})};
  const result=await app.inject({method:'POST',url:'/documents',headers,payload:multipart()});
  expect(result.statusCode).toBe(200);expect(result.body).toContain('"outputFormat":"'+expected+'"');
  const row=(await pool.query('SELECT * FROM tasks ORDER BY created_at DESC,id DESC LIMIT 1')).rows[0];expect(row.output_format).toBe(expected);expect(row.normalization_version).toBe(2);expect(row.normalization_summary.outputFormat).toBe(expected);
 }
});
it('retains format through intake restart and exposes it through lookup without reselection',async()=>{
 const t=await intake.open({authorization:auth,docKey:'format-small',contentType,outputFormat:'DOCX'});
 await intake.stop();intake=await createTaskIntake({pool,root,resolveCredential:identity,policy:{maxTasks:10,maxOwnerTasks:10,maxOutstanding:20},freeBytes:async()=>20_000_000_000});
 expect((await intake.inspect(auth,t.taskId)).outputFormat).toBe('docx');
 const {taskSnapshot}=await import('../dist/tasks/public.js');expect((await taskSnapshot(pool,intake,auth,t.taskId)).task.outputFormat).toBe('docx');
});
