import {it,expect,describe,beforeAll,beforeEach,afterAll} from 'vitest';
import {writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {policyWith} from '../dist/tasks/policy.js';
import {publicCode} from '../dist/tasks/public.js';
import {fixture,response,auth} from './taskDocxFixture.mjs';
import {taskWire} from '../dist/tasks/wire.js';
it('pins a separate trusted DOCX bound while retaining PDF and queue policy identities',()=>{
 const p=policyWith();expect(p.docxBytes).toBe(32*1048576);expect(p.pdfBytes).toBe(256*1048576);expect(p.version).toBe('task-v1-trial-1');
 expect(()=>policyWith({docxBytes:32*1048576+1})).toThrow();expect(policyWith({docxBytes:100}).docxBytes).toBe(100);
});
describe('real DOCX failure lifecycle',()=>{
 const f=fixture();beforeAll(()=>f.setup());beforeEach(()=>f.reset());afterAll(()=>f.close());
 async function noArtifact(id){
  const rows=(await f.pool.query('SELECT o.* FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1 AND o.deleted_at IS NULL',[id])).rows;expect(rows).toHaveLength(0);
  expect(await readdir(join(f.root,id,'output'))).toEqual([]);expect((await f.intake.inspect(auth,id)).outputFormat).toBe('docx');
  const stored=(await f.pool.query('SELECT role,stored_bytes FROM task_files WHERE task_id=$1 AND storage_key IS NOT NULL',[id])).rows,q=(await f.pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1',[id])).rows[0];
  expect(stored.every(r=>['payload','original_image'].includes(r.role))).toBe(true);expect(Number(q.storage_used_bytes)).toBe(stored.reduce((sum,r)=>sum+Number(r.stored_bytes),0));
 }
 it.each(['format','mime','pageCount'])('rejects a wrong %s observation after the real child completes',async field=>{
  const {renderTask}=await import('../dist/tasks/render.js');
  await f.reset({processing:{render:async(...args)=>{const r=await renderTask(...args);return field==='format'?{...r,outputFormat:'pdf'}:field==='mime'?{...r,mediaType:'application/pdf'}:{...r,receipt:{...r.receipt,pageCount:1}};}}});
  const id=await f.task(),out=response();await expect(f.manager.execute({authorization:auth,taskId:id,response:out})).rejects.toHaveProperty('code','STORAGE_IO');await noArtifact(id);
 },30000);
 it('enforces the frozen DOCX byte bound without publishing a partial artifact',async()=>{
  await f.reset({policy:{docxBytes:100}});const id=await f.task(),out=response();await expect(f.manager.execute({authorization:auth,taskId:id,response:out})).rejects.toHaveProperty('code','DOCX_OUTPUT_BUDGET_EXCEEDED');await noArtifact(id);expect(Buffer.concat(out.parts).toString()).toContain('LIMIT_EXCEEDED');
 },30000);
 it('cleans output after a real parent storage write fails',async()=>{
  let attempted=false;const files=f.intake.processingContext.files,open=files.open;files.open=async key=>{const h=await open(key);if(key.includes('/output/'))h.writeFile=async()=>{attempted=true;throw Object.assign(Error('private path must not leak'),{code:'ENOSPC'});};return h;};
  const id=await f.task(),out=response();await expect(f.manager.execute({authorization:auth,taskId:id,response:out})).rejects.toHaveProperty('code','ENOSPC');expect(attempted).toBe(true);await noArtifact(id);expect(Buffer.concat(out.parts).toString()).not.toContain('private path');expect(Buffer.concat(out.parts).toString()).not.toContain('PDF_FAILED');
 },30000);
 it('refuses changed stored bytes before sending artifact headers',async()=>{
  const id=await f.task(),out=response(),wire=taskWire(out,id),send=wire.artifact;
  wire.artifact=async(path,meta,signal)=>{await writeFile(path,'tampered');return send(path,meta,signal);};
  await expect(f.manager.execute({authorization:auth,taskId:id,response:out,wire})).rejects.toHaveProperty('code','STORAGE_IO');await noArtifact(id);expect(Buffer.concat(out.parts).toString()).not.toContain('Content-Disposition: attachment');
 },30000);
 it('cancels during child output and removes staged bytes only after the group stops',async()=>{
  const abort=new AbortController(),files=f.intake.processingContext.files,open=files.open;
  files.open=async key=>{const h=await open(key);if(key.includes('/output/'))abort.abort();return h;};
  const id=await f.task(),out=response();await expect(f.manager.execute({authorization:auth,taskId:id,response:out,signal:abort.signal})).rejects.toHaveProperty('code','CONNECTION_LOST');await noArtifact(id);expect((await f.pool.query('SELECT child_pid FROM tasks WHERE id=$1',[id])).rows[0].child_pid).toBe(null);
 },30000);
 it('cleans a killed real child and keeps the original input for diagnosis',async()=>{
  const id=await f.task(),pending=f.manager.execute({authorization:auth,taskId:id,response:response()}).catch(e=>e);let pid;const end=Date.now()+10000;
  while(!pid){pid=(await f.pool.query('SELECT child_pid FROM tasks WHERE id=$1',[id])).rows[0].child_pid;if(Date.now()>end)throw Error('child did not start');if(!pid)await new Promise(r=>setTimeout(r,5));}
  process.kill(-pid,'SIGKILL');expect((await pending).code).toBeTruthy();await noArtifact(id);
 },30000);
 it('rejects a worker with a different Core hash instead of repinning a normalized task',async()=>{
  const id=await f.task(),{rendererIdentity}=await import('../dist/fonts/snapshot.js'),old=rendererIdentity.sha256;
  try{rendererIdentity.sha256='f'.repeat(64);await expect(f.manager.execute({authorization:auth,taskId:id,response:response()})).rejects.toHaveProperty('code','RENDERER_PIN_MISMATCH');expect((await f.pool.query('SELECT * FROM generation_jobs WHERE task_id=$1',[id])).rows).toHaveLength(0);}finally{rendererIdentity.sha256=old;await f.intake.fail(id,'WORKER_INTERRUPTED');}
 },30000);
 it('charges a failed output deletion until retry and retains the frozen format through TTL cleanup',async()=>{
  let blocked=true;await f.reset({removeFile:async path=>{if(blocked&&path.includes('/output/'))throw Object.assign(Error('retry'),{code:'EACCES'});const {unlink}=await import('node:fs/promises');await unlink(path);}});
  const id=await f.task(),out=response(),write=out.write.bind(out),abort=new AbortController();out.write=async b=>{await write(b);if(Buffer.from(b).includes(Buffer.from('Content-Disposition: attachment;')))abort.abort();};
  await expect(f.manager.execute({authorization:auth,taskId:id,response:out,signal:abort.signal})).rejects.toBeTruthy();expect((await f.intake.inspect(auth,id)).cleanup.status).toBe('retry_needed');expect((await readdir(join(f.root,id,'output'))).length).toBeGreaterThan(0);
  blocked=false;await f.intake.sweep();await noArtifact(id);
  await f.pool.query('ALTER TABLE tasks DISABLE TRIGGER task_identity_guard');try{await f.pool.query("UPDATE tasks SET created_at=now()-interval '4 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[id]);}finally{await f.pool.query('ALTER TABLE tasks ENABLE TRIGGER task_identity_guard');}
  await f.intake.sweep();expect((await f.intake.inspect(auth,id)).outputFormat).toBe('docx');expect(Number((await f.pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1',[id])).rows[0].storage_used_bytes)).toBe(0);
 },30000);
});
it('reports DOCX limitations and failures without PDF error aliases or private messages',()=>{
 for(const code of ['DOCX_CAPABILITY_UNSUPPORTED','DOCX_GEOMETRY_UNREPRESENTABLE','DOCX_REQUIRED_RELATION_UNSUPPORTED'])expect(publicCode(code)).toBe('DOCX_UNSUPPORTED');
 for(const code of ['DOCX_RESOURCE_INVALID','DOCX_SERIALIZATION_FAILED','DOCX_INPUT_INVALID'])expect(publicCode(code)).toBe('DOCX_FAILED');
 expect(publicCode('DOCX_OUTPUT_BUDGET_EXCEEDED')).toBe('LIMIT_EXCEEDED');expect(publicCode('PDF_LAYOUT_FAILED')).toBe('PDF_FAILED');expect(publicCode('NATIVE_FAILURE','docx')).toBe('DOCX_FAILED');
});
