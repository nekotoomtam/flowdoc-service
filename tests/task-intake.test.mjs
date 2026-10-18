import {beforeAll,afterAll,beforeEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {Readable} from 'node:stream';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';import {once} from 'node:events';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';import {registerTemplate} from '../dist/templates/registry.js';
import {createServer} from '../dist/http/server.js';
const api=await import('../dist/tasks/intake.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;let service,root;
const auth='Bearer '+'a'.repeat(40),other='Bearer '+'b'.repeat(40),reader='Bearer '+'c'.repeat(40);
const identity=h=>h===auth?{ownerKey:'customer-a',principalId:'api-a',docKeys:['srs-basic'],taskRead:true}:h===reader?{ownerKey:'customer-a',principalId:'reader',docKeys:[],taskRead:true}:h===other?{ownerKey:'customer-b',principalId:'api-b',docKeys:['srs-basic'],taskRead:true}:null;
const contentType='multipart/form-data; boundary=task-boundary';
const bytes=Buffer.from([0xff,0xd8,0xff,0xe0,0,1,2,3]); // receipt fixture, not a decoded image
const payload=()=>JSON.stringify({data:{},sections:[],meta:{actorRef:'user-42'}});
const part=(name,data,type='image/jpeg')=>Buffer.concat([Buffer.from('--task-boundary\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+type+'\r\n\r\n'),Buffer.from(data),Buffer.from('\r\n')]);
const body=(json=payload(),extra=[part('/sections/0/assets/0/image',bytes)])=>Buffer.concat([part('payload',json,'application/json'),...extra,Buffer.from('--task-boundary--\r\n')]);
const request=(authorization=auth)=>({authorization,docKey:'srs-basic',contentType});
const open=()=>service.open(request());
const send=(id,data=body(),extra={})=>service.receive({taskId:id,authorization:auth,contentType,body:Readable.from((function*(){for(let i=0;i<data.length;i+=7)yield data.subarray(i,i+7);})()),...extra});
const age=async id=>{await pool.query('ALTER TABLE tasks DISABLE TRIGGER task_identity_guard');try{await pool.query("UPDATE tasks SET created_at=now()-interval '4 hours',expires_at=now()-interval '1 hour' WHERE id=$1",[id]);}finally{await pool.query('ALTER TABLE tasks ENABLE TRIGGER task_identity_guard');}};
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,JSON.stringify({...JSON.parse(readFileSync('examples/srs-template.json','utf8')),docKey:'srs-basic',templateId:'task-fixture'}))).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'flowdoc-task-test-'));});
beforeEach(async()=>{await service?.stop();if(api.createTaskIntake)service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000});});
afterAll(async()=>{await service?.stop();await db.close();});
const clear=async()=>{await service.stop();for(const {id} of (await pool.query("SELECT id FROM tasks WHERE status NOT IN ('failed','expired','succeeded')")).rows)await service.fail(id,'WORKER_INTERRUPTED');for(const {id} of (await pool.query('SELECT id FROM tasks')).rows){await age(id);}await service.sweep();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000});};

it('exposes a gated internal task intake boundary',()=>expect(api.createTaskIntake).toBeTypeOf('function'));
it('does not enable the public documents endpoint prematurely',async()=>{const app=createServer({pool,outputs:{},isReady:()=>true});try{expect((await app.inject({method:'POST',url:'/documents',payload:{}})).statusCode).toBe(404);}finally{await app.close();}});
it('authenticates before creation, rejects duplicate selection and hides other owners',async()=>{
 await clear();const before=Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count);
 for(const r of [{...request(),authorization:''},{...request(),docKey:['srs-basic','srs-basic']},{...request(),docKey:'srs-basic,srs-basic'},{...request(),contentEncoding:'gzip'}])await expect(service.open(r)).rejects.toHaveProperty('code');
 expect(Number((await pool.query('SELECT count(*) FROM tasks')).rows[0].count)).toBe(before);
 const t=await open();expect(t).toMatchObject({status:'awaiting_input',creator:{principalId:'api-a',actorRef:null},billingSubjectKey:null});
 expect(+new Date(t.expiresAt)-+new Date(t.createdAt)).toBe(10800000);
 await expect(service.inspect(other,t.taskId)).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
 expect((await service.inspect(reader,t.taskId)).taskId).toBe(t.taskId);
 await expect(service.receive({taskId:t.taskId,authorization:reader,contentType,body:Readable.from([body()])})).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('atomically caps simultaneous task openings and shared legacy queue admission',async()=>{
 await clear();const requests=await Promise.allSettled(Array.from({length:8},()=>open()));
 expect(requests.filter(r=>r.status==='fulfilled')).toHaveLength(2);
 expect(requests.filter(r=>r.status==='rejected').every(r=>r.reason.code==='QUEUE_FULL')).toBe(true);
 const c=await pool.connect();try{await c.query('BEGIN');const {reserveJobCapacity}=await import('../dist/jobs/capacity.js');await expect(reserveJobCapacity(c,2)).rejects.toMatchObject({code:'QUEUE_FULL'});await c.query('ROLLBACK');}finally{c.release();}
});
it('reserves actual unknown-size writes once across competing tasks',async()=>{
 await clear();await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,policy:{poolBytes:24*1048576}});
 const a=await open(),b=await open();const result=await Promise.allSettled([service.reserve(a.taskId,9*1048576),service.reserve(b.taskId,9*1048576)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.find(r=>r.status==='rejected').reason.code).toBe('STORAGE_CAPACITY');
 const r=(await pool.query('SELECT sum(storage_held_bytes) AS held,sum(storage_used_bytes) AS used FROM task_resource_reservations')).rows[0];expect(Number(r.held)).toBe(24*1048576);expect(Number(r.used)).toBe(0);
});
it('subtracts outstanding promises from physical free bytes before opening',async()=>{
 await clear();await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>268435456+12*1048576});await open();await expect(open()).rejects.toMatchObject({code:'STORAGE_CAPACITY'});
});
it('streams payload with no filename and binary chunks, pins template and seals without a job',async()=>{
 await clear();const t=await open(),r=await send(t.taskId);expect(r.status).toBe('validating');expect(r.creator.actorRef).toBe('user-42');expect(r.inputDigest).toMatch(/^[a-f0-9]{64}$/);
 const files=(await pool.query('SELECT * FROM task_files WHERE task_id=$1 ORDER BY part_order',[t.taskId])).rows;
 expect(files).toHaveLength(2);for(const f of files){const b=await readFile(join(root,f.storage_key));expect(b.length).toBe(Number(f.stored_bytes));expect(createHash('sha256').update(b).digest('hex')).toBe(f.checksum);expect(f.expected_bytes).toBe(null);}
 const quota=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[t.taskId])).rows[0];expect(Number(quota.storage_used_bytes)).toBe(files.reduce((n,f)=>n+Number(f.stored_bytes),0));
 expect((await pool.query('SELECT 1 FROM generation_jobs WHERE task_id=$1',[t.taskId])).rowCount).toBe(0);
 await expect(pool.query("UPDATE tasks SET owner_key='spoof' WHERE id=$1",[t.taskId])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query("UPDATE tasks SET expires_at=expires_at+interval '1 second' WHERE id=$1",[t.taskId])).rejects.toMatchObject({code:'55000'});
});
it.each(['{"docKey":"srs-basic","data":{},"sections":[]}','{"data":{},"data":{},"sections":[]}','{"data":{},"sections":[],"meta":{"ownerKey":"spoof"}}','{"data":{},"sections":[],"meta":{"actorRef":4}}','{"data":'])('rejects bad payload before sealing and records terminal facts: %s',async json=>{
 await clear();const t=await open();await expect(send(t.taskId,body(json,[]))).rejects.toHaveProperty('code');const r=await service.inspect(auth,t.taskId);expect(r.status).toBe('failed');expect((await pool.query('SELECT count(*) FROM task_usage WHERE task_id=$1',[t.taskId])).rows[0].count).toBe('1');
});
it('rejects missing/truncated/duplicate payload and keeps only closed originals',async()=>{
 await clear();const t=await open();const truncated=Buffer.concat([part('payload',payload(),'application/json'),Buffer.from('--task-boundary\r\nContent-Disposition: form-data; name="/sections/0/assets/0/image"\r\nContent-Type: image/jpeg\r\n\r\npartial')]);
 await expect(send(t.taskId,truncated)).rejects.toHaveProperty('code');const f=(await pool.query('SELECT * FROM task_files WHERE task_id=$1 AND deleted_at IS NULL',[t.taskId])).rows;expect(f).toHaveLength(1);expect(f[0].role).toBe('payload');expect((await stat(join(root,f[0].storage_key))).isFile()).toBe(true);
 const next=await open();await expect(send(next.taskId,body(payload(),[part('payload',payload(),'application/json')]))).rejects.toMatchObject({code:'INVALID_REQUEST'});
});
it('prevents a second receiver, stops on disconnect, retains completed input and frees slot',async()=>{
 await clear();const t=await open();const source=new Readable({read(){}}),abort=new AbortController();const pending=service.receive({taskId:t.taskId,authorization:auth,contentType,body:source,signal:abort.signal});await new Promise(r=>setTimeout(r,30));
 await expect(send(t.taskId)).rejects.toMatchObject({code:'TASK_REQUEST_CONFLICT'});abort.abort();await expect(pending).rejects.toMatchObject({code:'CONNECTION_LOST'});
 expect((await service.inspect(auth,t.taskId)).status).toBe('failed');expect((await pool.query('SELECT queue_slot_held FROM task_resource_reservations WHERE task_id=$1',[t.taskId])).rows[0].queue_slot_held).toBe(false);
});
it('expires active receiving work, removes files and retains task/events/usage',async()=>{
 await clear();const t=await open();const source=new Readable({read(){}});const pending=service.receive({taskId:t.taskId,authorization:auth,contentType,body:source});const observed=pending.catch(e=>e);await new Promise(r=>setTimeout(r,25));await age(t.taskId);await service.sweep();expect((await observed).code).toBe('TASK_EXPIRED');
 const view=await service.inspect(auth,t.taskId);expect(view.status).toBe('expired');expect(view.cleanup.status).toBe('done');expect((await pool.query('SELECT count(*) FROM task_events WHERE task_id=$1',[t.taskId])).rows[0].count).not.toBe('0');expect((await pool.query('SELECT count(*) FROM task_usage WHERE task_id=$1',[t.taskId])).rows[0].count).toBe('1');
});
it('reconciles sealed interrupted tasks after restart without rerender and never extends expiry',async()=>{
 await clear();const t=await open();await send(t.taskId);await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000});await service.recover();const r=await service.inspect(auth,t.taskId);expect(r.status).toBe('failed');expect(r.expiresAt).toEqual(t.expiresAt);expect((await pool.query('SELECT count(*) FROM generation_jobs WHERE task_id=$1',[t.taskId])).rows[0].count).toBe('0');
 await service.recover();expect((await pool.query('SELECT count(*) FROM task_usage WHERE task_id=$1',[t.taskId])).rows[0].count).toBe('1');
});
it('runs startup recovery and periodic expiry without caller polling',async()=>{
 await clear();const t=await open();await send(t.taskId);await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,policy:{sweepMs:20}});
 expect((await service.inspect(auth,t.taskId)).status).toBe('failed');await age(t.taskId);
 await new Promise(r=>setTimeout(r,200));expect((await service.inspect(auth,t.taskId)).cleanup.status).toBe('done');
});
it('keeps quota charged on deletion failure and retries without rewriting terminal facts',async()=>{
 await clear();const t=await open();await send(t.taskId);await service.fail(t.taskId,'WORKER_INTERRUPTED');await age(t.taskId);await service.stop();
 service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,removeFile:async()=>{throw Error('simulated removal failure');}});await service.sweep();expect((await service.inspect(auth,t.taskId)).cleanup.status).toBe('retry_needed');expect(Number((await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1',[t.taskId])).rows[0].storage_used_bytes)).toBeGreaterThan(0);
 await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000});await service.sweep();expect((await service.inspect(auth,t.taskId)).cleanup.status).toBe('done');expect((await service.inspect(auth,t.taskId)).status).toBe('failed');
 await expect(pool.query('DELETE FROM task_usage WHERE task_id=$1',[t.taskId])).rejects.toMatchObject({code:'55000'});await expect(pool.query('UPDATE task_events SET event_type=event_type WHERE task_id=$1',[t.taskId])).rejects.toMatchObject({code:'55000'});
});
it('recovers a genuinely killed receiver and removes only incomplete files',async()=>{
 await clear();const schema=(await pool.query('SELECT current_schema() AS name')).rows[0].name;
 const child=fork(new URL('./taskCrashReceiver.mjs',import.meta.url),[],{env:{...process.env,TASK_TEST_SCHEMA:schema,TASK_TEST_ROOT:root},stdio:['ignore','ignore','pipe','ipc']});
 let id;try{const [message]=await Promise.race([once(child,'message'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Crash child did not reach persisted receive')),10000))]);id=message.taskId;expect(id).toBeTruthy();const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await service.recover();const r=await service.inspect(auth,id);expect(r.status).toBe('failed');expect(r.error).toBe('WORKER_INTERRUPTED');
  expect((await pool.query('SELECT facts FROM task_usage WHERE task_id=$1',[id])).rows[0].facts.requestBytes).toBe(null);
  const f=(await pool.query('SELECT * FROM task_files WHERE task_id=$1 AND deleted_at IS NULL',[id])).rows;expect(f).toHaveLength(1);expect(f[0].role).toBe('payload');
  await age(id);await service.sweep();expect((await service.inspect(auth,id)).cleanup.status).toBe('done');
 }finally{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
},20000);
it.each([
 ['part header exceeds budget',()=>body(payload(),[Buffer.from('--task-boundary\r\nContent-Disposition: form-data; name="/photo"\r\nX-Long: '+ 'x'.repeat(17000)+'\r\n\r\nx\r\n')])],
 ['payload is missing',()=>Buffer.concat([part('/photo',bytes),Buffer.from('--task-boundary--\r\n')])],
 ['JSON depth is excessive',()=>body('{"data":'+ '['.repeat(65)+'0'+']'.repeat(65)+',"sections":[]}',[])],
 ['UTF-8 is invalid',()=>Buffer.concat([part('payload',Buffer.from([0xff]),'application/json'),Buffer.from('--task-boundary--\r\n')])]
])('rejects bounded transport faults: %s',async(_label,make)=>{await clear();const t=await open();await expect(send(t.taskId,make())).rejects.toHaveProperty('code');expect((await service.inspect(auth,t.taskId)).status).toBe('failed');});
it('bounds a large scalar incrementally without accepting it as usable data',async()=>{await clear();const t=await open();await expect(send(t.taskId,body(JSON.stringify({data:{text:'x'.repeat(65537)},sections:[]}),[]))).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});});
it('grows reservation while actually storing more than the initial allowance',async()=>{
 await clear();const t=await open(),large=Buffer.alloc(9*1048576,1),data=body(payload(),[part('/sections/0/assets/0/image',large)]);
 await service.receive({taskId:t.taskId,authorization:auth,contentType,body:Readable.from([data])});
 const q=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[t.taskId])).rows[0];expect(Number(q.storage_held_bytes)).toBe(16*1048576);expect(Number(q.storage_used_bytes)).toBeGreaterThan(9*1048576);
},30000);
it('drains an individually oversized image without failing complete transport',async()=>{
 await clear();await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,policy:{imageBytes:10}});const t=await open();
 expect((await send(t.taskId,body(payload(),[part('/image',Buffer.alloc(30))]))).status).toBe('validating');
 const f=(await pool.query("SELECT * FROM task_files WHERE task_id=$1 AND role='original_image'",[t.taskId])).rows[0];expect(f).toMatchObject({state:'omitted',error_code:'IMAGE_LIMIT',storage_key:null,stored_bytes:'0'});
});
it('keeps UTF-8 part identity and ignores a caller filename path',async()=>{
 await clear();const t=await open(),name='/sections/0/data/รูปภาพ/image';await send(t.taskId,body(payload(),[Buffer.concat([Buffer.from('--task-boundary\r\nContent-Disposition: form-data; name="'+name+'"; filename="../../caller.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),bytes,Buffer.from('\r\n')])]));
 const f=(await pool.query("SELECT * FROM task_files WHERE task_id=$1 AND role='original_image'",[t.taskId])).rows[0];expect(f.logical_path).toBe(name);expect(f.storage_key).toMatch(new RegExp('^'+t.taskId+'/input/[a-f0-9-]+.bin$'));
});
it('records disk write failure safely and does not leak its quota or path',async()=>{
 await clear();await service.stop();service=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,writeChunk:async()=>{throw Object.assign(Error(root+'/private-file'),{code:'ENOSPC'});}});const t=await open();
 await expect(send(t.taskId)).rejects.toMatchObject({code:'STORAGE_IO'});const q=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[t.taskId])).rows[0];expect(Number(q.storage_used_bytes)).toBe(0);expect(Number(q.storage_held_bytes)).toBe(0);expect(JSON.stringify(await service.inspect(auth,t.taskId))).not.toContain(root);
});
it('binds receiver fencing to the actual receiving process instead of a dead opener',async()=>{
 await clear();const schema=(await pool.query('SELECT current_schema() AS name')).rows[0].name;
 const child=fork(new URL('./taskCrashReceiver.mjs',import.meta.url),[],{env:{...process.env,TASK_TEST_SCHEMA:schema,TASK_TEST_ROOT:root,TASK_TEST_OPEN_ONLY:'1'},stdio:['ignore','ignore','pipe','ipc']});
 let pending;try{const [m]=await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const old=(await pool.query('SELECT * FROM tasks WHERE id=$1',[m.taskId])).rows[0],previous=old.lease_token,source=new Readable({read(){}}),abort=new AbortController();pending=service.receive({taskId:m.taskId,authorization:auth,contentType,body:source,signal:abort.signal}).catch(e=>e);
  try{for(let n=0;n<30;n++){const r=(await pool.query('SELECT * FROM tasks WHERE id=$1',[m.taskId])).rows[0];if(r.status==='receiving'){expect(r.writer_pid).toBe(process.pid);expect(r.lease_token).not.toBe(previous);break;}await new Promise(r=>setTimeout(r,20));}
   const second=await api.createTaskIntake({pool,root,resolveCredential:identity});await second.recover();expect((await service.inspect(auth,m.taskId)).status).toBe('receiving');await second.stop();
   const {taskRepository}=await import('../dist/tasks/repository.js'),{taskPolicy}=await import('../dist/tasks/policy.js');await taskRepository(pool,taskPolicy,async()=>20_000_000_000).finish(m.taskId,'WORKER_INTERRUPTED',old);expect((await service.inspect(auth,m.taskId)).status).toBe('receiving');
  }finally{abort.abort();await pending;}
 }finally{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
},20000);
it('keeps legacy upload reservations from spending physical space promised to tasks',async()=>{
 await clear();const t=await open();const {createResourceFiles}=await import('../dist/storage/resource-files.js'),{createUploads}=await import('../dist/uploads/service.js'),{readUploadConfig}=await import('../dist/uploads/config.js');
 const f=await createResourceFiles(await mkdtemp(join(tmpdir(),'task-legacy-'))),u=createUploads({pool,files:{...f,freeBytes:async()=>256*1048576+12*1048576},config:readUploadConfig({})});
 try{await expect(u.create({requestKey:randomUUID(),items:[{key:'image',source:'upload',mediaType:'image/png',byteSize:8*1048576}]})).rejects.toMatchObject({code:'STORAGE_CAPACITY'});expect((await service.inspect(auth,t.taskId)).status).toBe('awaiting_input');}finally{await u.stop();}
});
it('preserves the strictest active physical floor across policy snapshots',async()=>{
 await clear();const a=await open();const low=await api.createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>256*1048576+12*1048576,policy:{freeFloorBytes:1}});
 try{await expect(low.open(request())).rejects.toMatchObject({code:'STORAGE_CAPACITY'});expect((await service.inspect(auth,a.taskId)).status).toBe('awaiting_input');}finally{await low.stop();}
});
it('propagates shared capacity failure through legacy image preparation instead of omitting it',async()=>{
 await clear();await open();const {createResourceFiles}=await import('../dist/storage/resource-files.js'),{createUploads}=await import('../dist/uploads/service.js'),{readUploadConfig}=await import('../dist/uploads/config.js'),{prepareOwnedJobImages}=await import('../dist/images/job.js');
 const files=await createResourceFiles(await mkdtemp(join(tmpdir(),'task-image-'))),config=readUploadConfig({}),uploads=createUploads({pool,files,config});
 try{const set=await uploads.create({requestKey:randomUUID(),items:[{key:'image',source:'upload',mediaType:'image/jpeg',byteSize:bytes.length}]});await uploads.receive(set.uploadId,set.items[0].resourceId,Readable.from([bytes]));await uploads.finalize(set.uploadId);
 const wrapped={connect:()=>pool.connect(),query:(q,args)=>q.startsWith('INSERT INTO job_processing')?Promise.resolve({rows:[]}):q.startsWith('SELECT upload_id FROM upload_job_claims')?Promise.resolve({rows:[{upload_id:set.uploadId}]}):pool.query(q,args)};
 const document={nodes:{image:{id:'image',type:'image',props:{resourceId:set.items[0].resourceId,width:{unit:'pt',value:50},height:{unit:'pt',value:50}}}}};
 await expect(prepareOwnedJobImages(wrapped,randomUUID(),document,{config,files:{...files,freeBytes:async()=>256*1048576+12*1048576}},new AbortController().signal)).rejects.toMatchObject({code:'STORAGE_CAPACITY'});
 expect(document.nodes.image.props.resourceId).toBe(set.items[0].resourceId);
 }finally{await uploads.stop();}
});
