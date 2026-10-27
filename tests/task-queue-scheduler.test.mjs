import{beforeAll,beforeEach,afterAll,it,expect}from'vitest';import{Readable}from'node:stream';import{readFileSync}from'node:fs';import{mkdtemp,writeFile,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';import{request}from'node:http';import{createHash}from'node:crypto';
import{submitJob}from'../dist/jobs/admission.js';import{isolatedDatabase}from'./isolatedDatabase.mjs';import{migrate}from'../dist/db/migrate.js';import{registerTemplate}from'../dist/templates/registry.js';import{createTaskIntake}from'../dist/tasks/intake.js';import{createTaskProcessing}from'../dist/tasks/processing.js';import{startProcessor}from'../dist/jobs/processor.js';import{createServer}from'../dist/http/server.js';
const{generateDocumentTask}=await import(pathToFileURL(join(process.env.STAGE5_PLUGIN_ROOT,'scripts/task-client.mjs')).href);
const db=isolatedDatabase(),pool=db.pool,sid='10000000-0000-4000-8000-000000000011',token='z'.repeat(40),auth='Bearer '+token;let intake,manager,processor,app,base,root,paused=true;
const identity=h=>h===auth?{ownerKey:'owner',principalId:'creator',taskRead:true,docKeys:['queue-api']}:null;
function template(){const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.docKey=t.templateId='queue-api';t.nodeModelVersion=19;t.examples=[];t.globalSchema={type:'object',fields:{}};t.areaFormats={item:{key:'item',ownerAreaId:'parts',inputSchema:{type:'object',fields:{text:{type:'string',required:true}}},repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'field-ref',scope:'local',key:'text'}]}}}}};t.sections=[{id:sid,label:'Queue1',nameBase:'Queue',inputSchema:{type:'object',fields:{parts:{type:'area',areaId:'parts'}}},source:{kind:'authored',repeats:[],fragment:{rootIds:['parts'],nodes:{parts:{id:'parts',type:'area',props:{areaId:'parts'}}}}}}];return t;}
const payload=n=>({data:{},sections:[{id:sid,data:{parts:[{format:'item',data:{text:'QUEUE INPUT '+n}}]}}]}),multipart=n=>'--api-queue\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(payload(n))+'\r\n--api-queue--\r\n';
const headers={authorization:auth,'doc-key':'queue-api','content-type':'multipart/form-data; boundary=api-queue',accept:'multipart/mixed'};
const until=async check=>{const end=Date.now()+15000;while(!await check()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10));}};
let free=20_000_000_000,memory=128*1048576,renderer,policy={},entered=[],controllers=new Map(),live=0,peak=0,metricFault=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function heldRenderer(_c,row,_t,_f,signal){entered.push(row.id);live++;peak=Math.max(peak,live);return new Promise((resolve,reject)=>{let settled=false;const stop=()=>{if(settled)return;settled=true;live--;reject(signal.reason??Object.assign(Error(),{code:'RENDER_FAILED'}));};controllers.set(row.id,stop);signal.addEventListener('abort',stop,{once:true});});}
async function setup(){intake=await createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>free,queueResources:{sampleMs:10,readMemory:async()=>{if(metricFault)throw Error('injected metric loss');return{current:memory,max:1024*1048576};}},policy:{sweepMs:100000,...policy}});manager=await createTaskProcessing({pool,intake,workerReady:()=>true,...(renderer?{render:renderer}:{})});}
async function start(extra={}){processor=await startProcessor({pool,tasks:manager,files:{writePdf:async()=>{throw Error('unexpected legacy');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:10,...extra});}
async function input(n){const t=await intake.open({authorization:auth,docKey:'queue-api',contentType:headers['content-type'],queueMode:true});await intake.receiveQueued({authorization:auth,taskId:t.taskId,contentType:headers['content-type'],body:Readable.from([Buffer.from(multipart(n))])});return t.taskId;}
function output(){return{parts:[],start(){},async write(b){this.parts.push(Buffer.from(b));},async end(){},async abort(){}};}
async function queue(id,out=output(),signal){const done=manager.execute({authorization:auth,taskId:id,response:out,signal}).catch(e=>e);await until(async()=>(await pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status==='queued');return{done,out};}
const row=async id=>(await pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,JSON.stringify(template()))).ok).toBe(true);});
beforeEach(async()=>{await manager?.stop();await processor?.stop();await intake?.stop();if(intake){await pool.query('ALTER TABLE tasks DISABLE TRIGGER task_identity_guard');try{await pool.query("UPDATE tasks SET created_at=now()-interval '4 hours',expires_at=now()-interval '1 hour'");}finally{await pool.query('ALTER TABLE tasks ENABLE TRIGGER task_identity_guard');}await intake.sweep();}manager=processor=intake=undefined;root=await mkdtemp(join(tmpdir(),'queue-scheduler-'));free=20_000_000_000;memory=128*1048576;renderer=undefined;policy={};entered=[];controllers=new Map();live=peak=0;});
afterAll(async()=>{await manager?.stop();await processor?.stop();await intake?.stop();await db.close();});
it('starts two FIFO tasks without awaiting the first, never starts a third, and releases only the stopped worker',async()=>{
 metricFault=false;
 renderer=heldRenderer;await setup();const ids=[];const calls=[];for(let n=0;n<3;n++){ids.push(await input(n));calls.push(await queue(ids[n]));}await start();
 await sleep(600);expect(entered).toEqual(ids.slice(0,2));expect(intake.queueSnapshot()).toMatchObject({workers:2,creditsMiB:768});await sleep(150);expect(entered).toHaveLength(2);
 controllers.get(ids[0])();await calls[0].done;await until(()=>entered.length===3);expect(entered[2]).toBe(ids[2]);expect(peak).toBe(2);await manager.stop();await Promise.all(calls.map(v=>v.done));expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:0,creditsMiB:128});
});
it('stops two active workers on metric loss, preserves originals and emits failure feedback without PDF',async()=>{
 metricFault=false;renderer=heldRenderer;await setup();const ids=[await input(1),await input(2)],calls=[await queue(ids[0]),await queue(ids[1])];await start();await until(()=>entered.length===2);metricFault=true;
 try{const results=await Promise.all(calls.map(c=>c.done));expect(results.map(r=>r.code)).toEqual(['UNAVAILABLE','UNAVAILABLE']);expect(live).toBe(0);expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:0,creditsMiB:128});
 for(let n=0;n<ids.length;n++){expect((await row(ids[n])).terminal_reason).toBe('UNAVAILABLE');const f=(await pool.query('SELECT role FROM task_files WHERE task_id=$1 AND storage_key IS NOT NULL',[ids[n]])).rows;expect(f.map(v=>v.role)).toEqual(['payload']);expect(calls[n].out.parts.map(b=>b.toString()).join('')).toContain('UNAVAILABLE');expect(calls[n].out.parts.some(b=>b.includes(Buffer.from('%PDF-')))).toBe(false);expect((await pool.query('SELECT count(*) n FROM task_usage WHERE task_id=$1',[ids[n]])).rows[0].n).toBe('1');}
 }finally{metricFault=false;}
});
it('stops the newest worker under emergency pressure, resumes intake and sender waits without deadlock',async()=>{
 metricFault=false;renderer=heldRenderer;await setup();const ids=[await input(1),await input(2)],calls=[await queue(ids[0]),await queue(ids[1])];await start();await until(()=>entered.length===2);
 const resources=intake.processingContext.resources,abort=new AbortController(),req={order:5,expiresAt:Date.now()+10000,signal:abort.signal};let intakeGrant,senderGrant;
 const waitingIntake=resources.acquire('overlap-intake',{...req,kind:'intake'}).then(g=>intakeGrant=g),waitingSender=resources.acquire('overlap-sender',{...req,kind:'sender'}).then(g=>senderGrant=g);await sleep(30);expect(intakeGrant).toBeUndefined();expect(senderGrant).toBeUndefined();
 memory=900*1048576;const result=await calls[1].done;expect(result.code).toBe('RESOURCE_LIMIT');memory=100*1048576;await Promise.all([waitingIntake,waitingSender]);expect(intakeGrant).toBeDefined();expect(senderGrant).toBeDefined();intakeGrant.release();senderGrant.release();await manager.stop();await calls[0].done;expect(intake.queueSnapshot()).toMatchObject({workers:0,intakes:0,senders:0,creditsMiB:128});
});
it('waits for shared storage without starting render work, then starts the FIFO head after capacity returns',async()=>{
 renderer=heldRenderer;await setup();const a=await input(1),b=await input(2),calls=[await queue(a),await queue(b)];free=1;await start();await sleep(200);expect(entered).toEqual([]);expect((await row(a)).status).toBe('queued');expect((await row(b)).status).toBe('queued');
 // A provisional resource grant can exist while the async storage transaction
 // rejects admission. Assert its release and the unchanged render/DB state,
 // rather than sampling that transient reservation at one arbitrary instant.
 await until(()=>intake.queueSnapshot().workers===0);expect(entered).toEqual([]);expect((await row(a)).status).toBe('queued');expect((await row(b)).status).toBe('queued');
 free=20_000_000_000;await until(()=>entered.length===2);expect(entered).toEqual([a,b]);await manager.stop();await Promise.all(calls.map(c=>c.done));
});
it('waits for global memory without claiming or skipping a ready task',async()=>{
 renderer=heldRenderer;await setup();const a=await input(1),b=await input(2),calls=[await queue(a),await queue(b)];memory=500*1048576;await sleep(30);await start();await sleep(150);expect(entered).toEqual([]);expect((await row(a)).status).toBe('queued');memory=128*1048576;await until(()=>entered.length===2);expect(entered).toEqual([a,b]);await manager.stop();await Promise.all(calls.map(c=>c.done));
});
it('rejects a known impossible per-task workspace instead of waiting forever or launching',async()=>{
 renderer=heldRenderer;policy={taskBytes:100*1048576};await setup();const id=await input(1),call=await queue(id);await start();const result=await Promise.race([call.done,sleep(2500).then(()=>({code:'STILL_WAITING'}))]);expect(result.code).toBe('LIMIT_EXCEEDED');expect(entered).toEqual([]);expect((await row(id)).processing_started_at).toBe(null);expect(intake.queueSnapshot().workers).toBe(0);
});
it('drains task workers at a legacy FIFO turn and runs legacy alone before the next task',async()=>{
 renderer=heldRenderer;await setup();expect((await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);
 const a=await input(1),b=await input(2),calls=[await queue(a),await queue(b)];const old=await submitJob(pool,JSON.parse(readFileSync('examples/srs-request.json','utf8')));expect(old.ok).toBe(true);const c=await input(3);calls.push(await queue(c));
 let oldEntered=false,release;const held=new Promise(r=>release=r);
 await start({render:async()=>{oldEntered=true;expect(live).toBe(0);await held;return{ok:true,value:{bytes:Buffer.from('%PDF'),mediaType:'application/pdf'},warnings:[]};},files:{writePdf:async id=>({path:id+'.pdf',byteSize:4})}});
 try{await until(()=>entered.length===2);await sleep(100);expect(oldEntered).toBe(false);controllers.get(a)();await calls[0].done;await sleep(100);expect(oldEntered).toBe(false);expect(entered).toEqual([a,b]);controllers.get(b)();await calls[1].done;await until(()=>oldEntered);expect(entered).toEqual([a,b]);expect(intake.queueSnapshot()).toMatchObject({workers:1,creditsMiB:448});release();await until(()=>entered.includes(c));expect((await pool.query('SELECT status FROM generation_jobs WHERE id=$1',[old.value.jobId])).rows[0].status).toBe('succeeded');}
 finally{release();await manager.stop();await Promise.all(calls.map(c=>c.done));}
});
it('keeps worker credits until cancellation is acknowledged rather than until the abort signal',async()=>{
 let stopSeen=false,release;const held=new Promise(r=>release=r);renderer=async(_c,r,_t,_f,s)=>{entered.push(r.id);await new Promise(done=>s.addEventListener('abort',done,{once:true}));stopSeen=true;await held;throw s.reason;};
 await setup();const id=await input(1),abort=new AbortController(),call=await queue(id,output(),abort.signal);await start();await until(()=>entered.length===1);abort.abort();await until(()=>stopSeen);expect(intake.queueSnapshot().workers).toBe(1);expect((await row(id)).status).toBe('processing');release();expect((await call.done).code).toBe('CONNECTION_LOST');expect(intake.queueSnapshot().workers).toBe(0);
});
it('losing the sole leader stops both workers and fences their outputs and releases only after exit',async()=>{
 renderer=heldRenderer;await setup();const ids=[await input(1),await input(2)],calls=[await queue(ids[0]),await queue(ids[1])];let lock;
 const wrapped={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();lock??=c;return c;}};
 await start({pool:wrapped});await until(()=>entered.length===2);lock.emit('error',Error('leader lost'));expect(processor.isReady()).toBe(false);const results=await Promise.all(calls.map(c=>c.done));expect(results.map(r=>r.code)).toEqual(['WORKER_INTERRUPTED','WORKER_INTERRUPTED']);expect(live).toBe(0);expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:0});
 expect((await pool.query('SELECT count(*) n FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=ANY($1::uuid[])',[ids])).rows[0].n).toBe('0');expect((await pool.query('SELECT count(*) n FROM task_usage WHERE task_id=ANY($1::uuid[])',[ids])).rows[0].n).toBe('2');
});
it('holds scheduling during foreign-group quarantine and resumes safely without restarting the processor',async()=>{
 renderer=heldRenderer;await setup();const id=await input(0),{spawn}=await import('node:child_process'),{once}=await import('node:events'),{hostname}=await import('node:os');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(child,'spawn');let closed=false;child.once('close',()=>closed=true);
 try{await pool.query('UPDATE tasks SET writer_pid=2147483647,writer_host=$2,writer_start_identity=NULL,child_pid=$3,child_host=$2 WHERE id=$1',[id,hostname(),child.pid]);await intake.recover();expect(intake.quarantined()).toBe(true);await start();await sleep(100);expect(processor.isReady()).toBe(true);process.kill(-child.pid,'SIGKILL');await once(child,'close');await intake.recover();expect(intake.quarantined()).toBe(false);const next=await input(1),pending=manager.execute({authorization:auth,taskId:next,response:output()}).catch(e=>e);await until(()=>entered.includes(next));await manager.stop();await pending;expect(processor.isReady()).toBe(true);}
 finally{if(!closed){process.kill(-child.pid,'SIGKILL');await once(child,'close');}}
});
it('retains the legacy credit and stops readiness when group termination cannot be confirmed',async()=>{
 await setup();expect((await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);expect((await submitJob(pool,JSON.parse(readFileSync('examples/srs-request.json','utf8')))).ok).toBe(true);
 await start({render:async()=>{throw Object.assign(Error('injected unconfirmed legacy group'),{code:'WORKER_STOP_UNCONFIRMED'});}});await sleep(150);expect(processor.isReady()).toBe(false);expect(intake.queueSnapshot().workers).toBe(1);
});
it('uses sender credits after group exit, and starts the send deadline only after acquiring a sender',async()=>{
 policy={sendMs:2000};await setup();const res=intake.processingContext.resources,grants=[];for(let n=0;n<2;n++)grants.push(res.tryAcquire('held-sender-'+n,{kind:'sender',order:n,expiresAt:Date.now()+30000}));
 const id=await input(1),call=await queue(id);await start();try{await until(async()=>(await row(id)).status==='sending');expect((await row(id)).send_started_at).toBe(null);expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:2});await sleep(2200);expect((await row(id)).terminal_at).toBe(null);grants[0].release();expect((await call.done).status).toBe('succeeded');}
 finally{grants.forEach(g=>g.release());await call.done;}
 expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:0,creditsMiB:128});
},30000);
it('reaps a force-killed real worker while its peer succeeds, then recovers the same root without replaying either job',async()=>{
 await setup();const files=intake.processingContext.files,open=files.open.bind(files);let release;const held=new Promise(r=>release=r),blocked=new Set();
 files.open=async key=>{const h=await open(key);if(!key.includes('/output/'))return h;return new Proxy(h,{get(target,k){if(k==='writeFile')return async b=>{blocked.add(key.split('/')[0]);await held;return target.writeFile(b);};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});};
 const ids=[await input('KILL'),await input('SURVIVE')],calls=[await queue(ids[0]),await queue(ids[1])];await start();
 try{await until(()=>blocked.size===2);const rows=(await pool.query('SELECT id,child_pid FROM tasks WHERE id=ANY($1::uuid[])',[ids])).rows;expect(rows.every(r=>r.child_pid>0)).toBe(true);expect(new Set(rows.map(r=>r.child_pid)).size).toBe(2);process.kill(-rows.find(r=>r.id===ids[0]).child_pid,'SIGKILL');release();const result=await Promise.all(calls.map(c=>c.done));expect(result[0].code).toBe('RENDER_FAILED');expect(result[1].status).toBe('succeeded');
 const bytes=Buffer.concat(calls[1].out.parts),header=bytes.indexOf(Buffer.from('Content-Type: application/pdf')),start=bytes.indexOf(Buffer.from('\r\n\r\n'),header)+4,size=Number(bytes.subarray(header,start).toString().match(/Content-Length: (\d+)/)[1]);if(process.env.FLOWDOC_TASK_PROOF_DIR)await writeFile(join(process.env.FLOWDOC_TASK_PROOF_DIR,'native-peer-survivor.pdf'),bytes.subarray(start,start+size));
 expect((await pool.query('SELECT child_pid FROM tasks WHERE id=ANY($1::uuid[])',[ids])).rows.every(r=>r.child_pid===null)).toBe(true);expect(intake.queueSnapshot()).toMatchObject({workers:0,senders:0,creditsMiB:128});
 await manager.stop();await processor.stop();processor=undefined;await intake.stop();await setup();await intake.recover();expect((await row(ids[0])).status).toBe('failed');expect((await row(ids[1])).status).toBe('succeeded');expect((await pool.query('SELECT count(*) n FROM task_usage WHERE task_id=ANY($1::uuid[])',[ids])).rows[0].n).toBe('2');expect((await pool.query('SELECT count(*) n FROM generation_jobs WHERE task_id=ANY($1::uuid[])',[ids])).rows[0].n).toBe('2');expect(intake.quarantined()).toBe(false);
 }finally{release();await Promise.all(calls.map(c=>c.done));}
},30000);
