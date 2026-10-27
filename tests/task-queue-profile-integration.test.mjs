import{it,expect}from'vitest';import{readFileSync}from'node:fs';import{mkdtemp}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{Readable}from'node:stream';
import{isolatedDatabase}from'./isolatedDatabase.mjs';import{migrate}from'../dist/db/migrate.js';import{registerTemplate}from'../dist/templates/registry.js';import{createTaskIntake}from'../dist/tasks/intake.js';import{createTaskProcessing}from'../dist/tasks/processing.js';import{startProcessor}from'../dist/jobs/processor.js';import{SIX_GIB_QUEUE_PROFILE,FOUR_GIB_QUEUE_PROFILE}from'../dist/tasks/queue-profile.js';
import{queueAdmissionLimit,readTaskQueueConfig}from'../dist/tasks/queue-profile.js';import{submitJob}from'../dist/jobs/admission.js';
const sid='10000000-0000-4000-8000-000000000061',auth='Bearer '+'6'.repeat(40),contentType='multipart/form-data; boundary=profile-six',MiB=1048576;
const until=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10));}};
async function fixture(maxOutstanding,options={}){
 const db=isolatedDatabase();await db.setup();expect((await migrate(db.pool)).ok).toBe(true);
 const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.docKey=t.templateId='profile-six';t.nodeModelVersion=19;t.examples=[];t.globalSchema={type:'object',fields:{}};
 t.areaFormats={item:{key:'item',ownerAreaId:'parts',inputSchema:{type:'object',fields:{text:{type:'string',required:true}}},repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'field-ref',scope:'local',key:'text'}]}}}}};
 t.sections=[{id:sid,label:'Six',nameBase:'Six',inputSchema:{type:'object',fields:{parts:{type:'area',areaId:'parts'}}},source:{kind:'authored',repeats:[],fragment:{rootIds:['parts'],nodes:{parts:{id:'parts',type:'area',props:{areaId:'parts'}}}}}}];expect((await registerTemplate(db.pool,JSON.stringify(t))).ok).toBe(true);
 const intake=await createTaskIntake({pool:db.pool,root:await mkdtemp(join(tmpdir(),'queue-six-')),resolveCredential:h=>h===auth?{ownerKey:'six',principalId:'six',taskRead:true,docKeys:['profile-six']}:null,policy:{maxOutstanding,...options.policy},...(options.writeChunk?{writeChunk:options.writeChunk}:{}),freeBytes:async()=>20_000_000_000,queueResources:{profile:{...SIX_GIB_QUEUE_PROFILE,adaptiveProcessing:false,maxProcessing:2,...options.profile},readCpuLimit:async()=>2,readCpuUsage:options.readCpuUsage??(async()=>0),readMemory:async()=>({current:1024*MiB,max:options.profile?.memoryBytes??6144*MiB}),sampleMs:10}});
 return{db,intake,open:()=>intake.open({authorization:auth,docKey:'profile-six',contentType,queueMode:true}),async close(){await intake.stop();await db.close();}};
}
for(const cap of[10,20])it('transactionally admits exactly'+cap+' requests for the explicit6GiB profile',async()=>{
 const f=await fixture(cap);try{const rows=await Promise.all(Array.from({length:cap},()=>f.open()));expect(new Set(rows.map(t=>t.taskId)).size).toBe(cap);await expect(f.open()).rejects.toMatchObject({code:'QUEUE_FULL'});expect(f.intake.queueCapability()).toMatchObject({maxOutstanding:cap,maxOwnerTasks:cap,maxProcessing:2,resourceProfile:{name:'6g-2cpu',memoryBytes:6144*MiB,cpuCount:2}});const records=(await f.db.pool.query('SELECT resource_policy FROM tasks')).rows;expect(records).toHaveLength(cap);expect(records.every(r=>r.resource_policy.version==='task-v1-queue-6g-2cpu-trial-3'&&r.resource_policy.memoryStopBytes===5376*MiB)).toBe(true);}finally{await f.close();}
},30000);
for(const cap of[10,20])it('shares ceiling'+cap+' across legacy job and queue-v1 admission',async()=>{
 const f=await fixture(cap);try{
  expect((await registerTemplate(f.db.pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);
  await Promise.all(Array.from({length:cap-1},()=>f.open()));
  const effective=queueAdmissionLimit(10,readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:String(cap)}));
  const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
  expect((await submitJob(f.db.pool,input,false,effective)).ok).toBe(true);
  await expect(f.open()).rejects.toMatchObject({code:'QUEUE_FULL'});
  const rejected=await submitJob(f.db.pool,input,false,effective);expect(rejected.ok).toBe(false);expect(rejected.issues[0].code).toBe('QUEUE_FULL');
 }finally{await f.close();}
},30000);
it('normalizes and dispatches the new policy through the shared two-worker scheduler',async()=>{
 const f=await fixture(20);let manager,processor;const calls=[];let live=0,peak=0;
 try{
  manager=await createTaskProcessing({pool:f.db.pool,intake:f.intake,workerReady:()=>true,render:async(_c,_r,_t,_s,signal)=>{live++;peak=Math.max(peak,live);try{await new Promise((_,reject)=>{const stopped=()=>reject(signal.reason);signal.addEventListener('abort',stopped,{once:true});if(signal.aborted)stopped();});}finally{live--;}}});
  for(let n=0;n<3;n++){
   const t=await f.open(),payload={data:{},sections:[{id:sid,data:{parts:[{format:'item',data:{text:'SIX '+n}}]}}]},body=Buffer.from('--profile-six\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(payload)+'\r\n--profile-six--\r\n');
   await f.intake.receiveQueued({authorization:auth,taskId:t.taskId,contentType,body:Readable.from([body])});
   const response={start(){},async write(){},async end(){},async abort(){}};
   calls.push(manager.execute({authorization:auth,taskId:t.taskId,response}).catch(e=>e));await until(async()=>(await f.db.pool.query('SELECT status FROM tasks WHERE id=$1',[t.taskId])).rows[0].status==='queued');
  }
  processor=await startProcessor({pool:f.db.pool,tasks:manager,files:{writePdf:async()=>{throw Error('unexpected legacy job');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:10});
  await until(()=>live===2);await new Promise(r=>setTimeout(r,100));expect(peak).toBe(2);expect(f.intake.queueSnapshot()).toMatchObject({workers:2});
 }finally{await manager?.stop();await processor?.stop();await Promise.all(calls);await f.close();}
 expect(live).toBe(0);
},30000);

const uploadBody=()=>Buffer.from('--profile-six\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({data:{},sections:[{id:sid,data:{parts:[{format:'item',data:{text:'TIMING'}}]}}]})+'\r\n--profile-six--\r\n');
const receive=(f,id,body,signal)=>f.intake.receiveQueued({authorization:auth,taskId:id,contentType,body,signal});
it('excludes slow owned file writes from upstream silence while preserving the stored input',async()=>{
 const f=await fixture(10,{policy:{idleMs:40},profile:{idleMs:40},writeChunk:async(h,b)=>{await new Promise(r=>setTimeout(r,130));await h.writeFile(b);}});
 try{const row=await f.open();await receive(f,row.taskId,Readable.from([uploadBody()]));const actual=(await f.db.pool.query('SELECT status,normalized_at,terminal_reason FROM tasks WHERE id=$1',[row.taskId])).rows[0];expect(actual.normalized_at).not.toBe(null);expect(actual.terminal_reason).toBeNull();expect(f.intake.queueSnapshot()).toMatchObject({intakes:0,waiters:0});}finally{await f.close();}
},30000);
it('still times out a genuinely silent upstream and releases its grant',async()=>{
 const f=await fixture(10,{policy:{idleMs:50},profile:{idleMs:50}});try{const row=await f.open();await expect(receive(f,row.taskId,new Readable({read(){}}))).rejects.toMatchObject({code:'TASK_TIMEOUT'});expect((await f.intake.inspect(auth,row.taskId)).status).toBe('failed');expect(f.intake.queueSnapshot()).toMatchObject({intakes:0,waiters:0});}finally{await f.close();}
},30000);
it('retains the absolute receive deadline during slow local work',async()=>{
 const f=await fixture(10,{policy:{idleMs:50,receiveMs:120},profile:{idleMs:50},writeChunk:async(h,b)=>{await new Promise(r=>setTimeout(r,220));await h.writeFile(b);}});try{const row=await f.open();await expect(receive(f,row.taskId,Readable.from([uploadBody()]))).rejects.toMatchObject({code:'TASK_TIMEOUT'});expect(f.intake.queueSnapshot()).toMatchObject({intakes:0,waiters:0});}finally{await f.close();}
},30000);
it('cancels during excluded local IO without extending task ownership',async()=>{
 let entered=false;const f=await fixture(10,{policy:{idleMs:40},profile:{idleMs:40},writeChunk:async(h,b)=>{entered=true;await new Promise(r=>setTimeout(r,130));await h.writeFile(b);}});try{const row=await f.open(),stop=new AbortController(),done=receive(f,row.taskId,Readable.from([uploadBody()]),stop.signal).catch(e=>e);await until(()=>entered);stop.abort();expect((await done).code).toBe('CONNECTION_LOST');expect((await f.intake.inspect(auth,row.taskId)).status).toBe('failed');expect(f.intake.queueSnapshot()).toMatchObject({intakes:0,waiters:0});}finally{await f.close();}
},30000);
it('starts processing time only after worker admission even when queue wait exceeds that budget',async()=>{
 const f=await fixture(10,{policy:{processMs:90},profile:{processMs:90}});let manager,processor;const calls=[];
 try{
  manager=await createTaskProcessing({pool:f.db.pool,intake:f.intake,workerReady:()=>true,render:async(_c,_r,_t,_s,signal)=>{await new Promise((_,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});}});
  const ids=[];for(let i=0;i<3;i++){const row=await f.open();ids.push(row.taskId);await receive(f,row.taskId,Readable.from([uploadBody()]));calls.push(manager.execute({authorization:auth,taskId:row.taskId,response:{start(){},async write(){},async end(){},async abort(){}}}).catch(e=>e));await until(async()=>(await f.db.pool.query('SELECT status FROM tasks WHERE id=$1',[row.taskId])).rows[0].status==='queued');}
  await new Promise(r=>setTimeout(r,220));expect((await f.db.pool.query("SELECT count(*) n FROM tasks WHERE status='queued'")).rows[0].n).toBe('3');
  processor=await startProcessor({pool:f.db.pool,tasks:manager,files:{writePdf:async()=>{throw Error('unexpected legacy');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:10});await until(async()=>(await f.db.pool.query("SELECT count(*) n FROM tasks WHERE terminal_reason='TASK_TIMEOUT'")).rows[0].n==='3');
  for(const row of(await f.db.pool.query('SELECT created_at,processing_started_at,terminal_at FROM tasks')).rows){expect(+row.processing_started_at-+row.created_at).toBeGreaterThan(220);expect(+row.terminal_at-+row.processing_started_at).toBeGreaterThanOrEqual(85);}
 }finally{await manager?.stop();await processor?.stop();await Promise.all(calls);await f.close();}
},30000);
for(const profile of[SIX_GIB_QUEUE_PROFILE,FOUR_GIB_QUEUE_PROFILE])it(profile.name+' runs three held renderers when headroom permits and backs off without cancelling them',async()=>{
 let busy=false,cpu=0,last=Date.now();const f=await fixture(20,{profile:{...profile,adaptiveProcessing:true,maxProcessing:3},readCpuUsage:async()=>{const now=Date.now();if(busy)cpu+=(now-last)*2000*.99;last=now;return Math.round(cpu);}});let manager,processor;const calls=[],controllers=[],entered=[];let live=0,peak=0;
 try{
  expect(f.intake.queueCapability()).toMatchObject({maxOutstanding:20,maxProcessing:3,adaptiveProcessing:{enabled:true,minimum:1,maximum:3}});
  manager=await createTaskProcessing({pool:f.db.pool,intake:f.intake,workerReady:()=>true,render:async(_c,row,_t,_s,signal)=>{entered.push(row.id);live++;peak=Math.max(peak,live);try{await new Promise((_,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});}finally{live--;}}});
  const ids=[];for(let i=0;i<4;i++){const row=await f.open();ids.push(row.taskId);await receive(f,row.taskId,Readable.from([uploadBody()]));const stop=new AbortController();controllers.push(stop);calls.push(manager.execute({authorization:auth,taskId:row.taskId,signal:stop.signal,response:{start(){},async write(){},async end(){},async abort(){}}}).catch(e=>e));await until(async()=>(await f.db.pool.query('SELECT status FROM tasks WHERE id=$1',[row.taskId])).rows[0].status==='queued');}
  processor=await startProcessor({pool:f.db.pool,tasks:manager,files:{writePdf:async()=>{throw Error('unexpected legacy');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:10});await until(()=>live===3);expect(entered).toEqual(ids.slice(0,3));expect(peak).toBe(3);
  busy=true;await until(()=>f.intake.processingContext.resources.processingLimit()===2);expect(live).toBe(3);expect(entered).toHaveLength(3);controllers[0].abort();await until(()=>live===2);await new Promise(r=>setTimeout(r,150));expect(entered).toHaveLength(3);expect((await f.db.pool.query('SELECT status FROM tasks WHERE id=$1',[ids[3]])).rows[0].status).toBe('queued');
  busy=false;await until(()=>entered.length===4);expect(live).toBe(3);expect(peak).toBe(3);
 }finally{controllers.forEach(c=>c.abort());await manager?.stop();await processor?.stop();await Promise.all(calls);await f.close();}
 expect(live).toBe(0);
},30000);

it('transactionally admits20tasks with4GiB policy and cleans waiting work',async()=>{const f=await fixture(20,{profile:FOUR_GIB_QUEUE_PROFILE});try{const tasks=await Promise.all(Array.from({length:20},()=>f.open()));expect(tasks).toHaveLength(20);await expect(f.open()).rejects.toMatchObject({code:'QUEUE_FULL'});expect(f.intake.queueCapability()).toMatchObject({maxOutstanding:20,maxProcessing:3,resourceProfile:{name:'4g-2cpu',memoryBytes:4096*MiB}});const rows=(await f.db.pool.query('SELECT resource_policy FROM tasks')).rows;expect(rows.every(r=>r.resource_policy.version==='task-v1-queue-4g-2cpu-trial-1'&&r.resource_policy.memoryPauseBytes===3072*MiB&&r.resource_policy.memoryStopBytes===3584*MiB)).toBe(true);}finally{await f.close();}},30000);
