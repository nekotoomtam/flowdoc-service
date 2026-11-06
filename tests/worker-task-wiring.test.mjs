import {it,expect,describe,beforeAll,afterAll} from 'vitest';
import {readFile,writeFile,rm,open,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {renderTask} from '../dist/tasks/render.js';
import {taskReadBudget} from '../dist/tasks/read-cache-budget.js';
import {fixture,deferred} from './helpers/worker-task-fixture.mjs';
const errorCode=e=>e?.code;
it.runIf(!process.env.FLOWDOC_WORKER_LAB)('keeps the original Python per-file hard limiter inherited by Node writes',async()=>{
 const f=await fixture(),path=f.root+'/bounded-file';try{const child=spawn('python',['runtime/python/task_launcher.py','4096',process.execPath,'-e','require("node:fs").writeFileSync(process.argv[1],Buffer.alloc(8192))',path],{stdio:'ignore'});const [code]=await once(child,'close');expect(code).not.toBe(0);expect((await stat(path)).size).toBeLessThanOrEqual(4096);}finally{await rm(f.root,{recursive:true,force:true});}
});
it('tracks and records blocked PID before binding, starts once and sends init afterwards',async()=>{
 const f=await fixture();try{await expect(renderTask(f.context,f.row,{},f.snapshot,new AbortController().signal)).rejects.toMatchObject({code:'RENDER_FAILED'});expect(f.trace.filter(x=>['spawn','track','db-pid','bind','start','init'].includes(x))).toEqual(['spawn','track','db-pid','bind','start','init']);expect(f.trace.indexOf('stop')).toBeLessThan(f.trace.indexOf('untrack'));expect(f.context.launchSpec).toMatchObject({kind:'task-render',fenceFd:4,fileBytes:10485760});}finally{await rm(f.root,{recursive:true,force:true});}
});
it('stops and reaps a blocked worker if DB PID persistence fails, without init or retry',async()=>{
 const stop=deferred(),f=await fixture({pidFailure:true,holdStop:stop.promise}),before=taskReadBudget.snapshot().readers;const pending=renderTask(f.context,f.row,{},f.snapshot,new AbortController().signal);const rejected=expect(pending).rejects.toMatchObject({code:'DB_FAULT'});await new Promise(r=>setTimeout(r,20));expect(f.trace).not.toContain('untrack');expect(taskReadBudget.snapshot().readers).toBe(before+1);stop.resolve();await rejected;expect(f.trace).not.toContain('bind');expect(f.trace).not.toContain('init');expect(f.trace.filter(x=>x==='spawn')).toHaveLength(1);expect(taskReadBudget.snapshot().readers).toBe(before);await rm(f.root,{recursive:true,force:true});
});
it('cancellation racing bind does not send init or start a second worker',async()=>{
 const bind=deferred(),f=await fixture({holdBind:bind.promise}),abort=new AbortController();const p=renderTask(f.context,f.row,{},f.snapshot,abort.signal);const rejected=expect(p).rejects.toBeTruthy();await new Promise(r=>setTimeout(r,20));abort.abort();bind.resolve();await rejected;expect(f.trace).not.toContain('init');expect(f.trace.filter(x=>x==='spawn')).toHaveLength(1);await rm(f.root,{recursive:true,force:true});
});
it('required mode rejects missing launcher before workspace, DB or default task processing',async()=>{
 const old=process.env.FLOWDOC_WORKER_ISOLATION;process.env.FLOWDOC_WORKER_ISOLATION='required';try{
  await expect(renderTask({}, {}, {},{},new AbortController().signal)).rejects.toMatchObject({code:'WORKER_TASK_LAUNCHER_REQUIRED'});
  const {createTaskIntake}=await import('../dist/tasks/intake.js');await expect(createTaskIntake({})).rejects.toMatchObject({code:'WORKER_TASK_LAUNCHER_REQUIRED'});
  const {createTaskProcessing}=await import('../dist/tasks/processing.js');await expect(createTaskProcessing({intake:{processingContext:{}}})).rejects.toMatchObject({code:'WORKER_TASK_LAUNCHER_REQUIRED'});
 }finally{if(old===undefined)delete process.env.FLOWDOC_WORKER_ISOLATION;else process.env.FLOWDOC_WORKER_ISOLATION=old;}
});
it('unknown stop keeps owner tracking, read credit and scratch instead of masking DB error',async()=>{
 const f=await fixture({pidFailure:true,unknown:true}),before=taskReadBudget.snapshot().readers;await writeFile(f.work+'/held','owned');await expect(renderTask(f.context,f.row,{},f.snapshot,new AbortController().signal)).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});expect(f.trace).not.toContain('untrack');expect(f.trace).not.toContain('db-clear');expect(taskReadBudget.snapshot().readers).toBe(before+1);expect((await stat(f.work)).isDirectory()).toBe(true);await rm(f.root,{recursive:true,force:true});
});
describe.skipIf(!process.env.FLOWDOC_WORKER_LAB)('native P3 task transport',()=>{
 let launcher,config;
 async function reset(deps={}){await launcher.drain();const token=Date.now()+'-'+Math.random();await writeFile('/results/app/host-request.json',JSON.stringify({token,action:'restart-broker'}));const end=Date.now()+15000;while(true){try{const m=JSON.parse(await readFile('/results/app/host-response.json','utf8'));if(m.token===token&&m.ok)break;}catch{}if(Date.now()>end)throw Error('broker reset timeout');await new Promise(r=>setTimeout(r,20));}launcher=await(await import('../dist/workers/launcher.js')).createWorkerLauncher(config,deps);}
 beforeAll(async()=>{
  await writeFile('/results/app/coordinator-ready.json',JSON.stringify({pid:process.pid,start:(await readFile('/proc/self/stat','utf8')).split(')')[1].trim().split(/\s+/)[19]}));const end=Date.now()+20000;while(true){try{await readFile('/results/public-anchor.json');break;}catch{if(Date.now()>end)throw Error('lab anchor timeout');await new Promise(r=>setTimeout(r,20));}}
  const {readWorkerConfig}=await import('../dist/workers/config.js');const {createWorkerLauncher}=await import('../dist/workers/launcher.js');config=readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json'});launcher=await createWorkerLauncher(config);
 },25000);
 afterAll(async()=>{await launcher?.drain();});
 it('native task remains blocked when DB PID save fails and returns read credit only after stop',async()=>{
  const fence=await open('/results/app/task-fence','w+');const f=await fixture({launcher,pidFailure:true});f.context.ownership.fenceFd=fence.fd;
  try{await expect(renderTask(f.context,f.row,{},f.snapshot,new AbortController().signal)).rejects.toMatchObject({code:'DB_FAULT'});expect(f.trace).not.toContain('init');expect(f.trace.indexOf('db-pid')).toBeLessThan(f.trace.indexOf('untrack'));}finally{await fence.close();await rm(f.root,{recursive:true,force:true});}
 });
 it('task init preserves advanced Buffer BigInt Map typed array and exact FD4 through the gate',async()=>{
  await reset({resolvePayload:()=>({executable:process.execPath,args:['/candidate/tests/helpers/worker-payload.mjs','task-render']})});
  const fence=await open('/results/app/advanced-fence','w+');let reply;const proxy={...launcher,async spawnBlocked(s){const h=await launcher.spawnBlocked(s);h.child.on('message',m=>{reply=m;});return h;}};const f=await fixture({launcher:proxy});f.context.ownership.fenceFd=fence.fd;const template={buf:Buffer.from([0,128,255]),big:42n,map:new Map([['ไทย',7]]),typed:new Uint16Array([1,65535])};
  try{await expect(renderTask(f.context,f.row,template,f.snapshot,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_DATA'});expect(reply.input.template).toEqual(template);expect(reply.fenceIno).toBe((await fence.stat()).ino);}finally{await fence.close();await rm(f.root,{recursive:true,force:true});await reset();}
 });
 it('runs the actual task child for PDF and DOCX with the original ownership fence and streams valid artifacts',async()=>{
  const {validateTemplate,normalizeTaskInput}=await import('@flowdoc/core');const {openTaskJson}=await import('../dist/tasks/json-reader.js');const {createTaskImageIndex}=await import('../dist/tasks/image-index.js');const {createTaskOwnership}=await import('../dist/tasks/ownership.js');const {makeFontSnapshot,rendererIdentity}=await import('../dist/fonts/snapshot.js');const {LEGACY_SARABUN}=await import('../dist/fonts/legacy.js');
  const definition=JSON.parse(await readFile('examples/srs-template.json','utf8')),request=JSON.parse(await readFile('examples/srs-request.json','utf8')),valid=validateTemplate(definition);expect(valid.ok).toBe(true);
  for(const variant of ['pdf','docx','pdf-fail-save']){
   const format=variant==='docx'?'docx':'pdf',summaryFailure=variant==='pdf-fail-save';let launches=0;
   const proxy={...launcher,async spawnBlocked(spec){launches++;return launcher.spawnBlocked(spec);}};
   const f=await fixture({launcher:proxy,summaryFailure});let owner;try{
    owner=await createTaskOwnership(f.root);f.context.ownership=owner;f.row.output_format=format;f.row.normalization_version=2;
    await f.write('payload',JSON.stringify({data:request.data,sections:request.sections}));const reader=await openTaskJson(f.root+'/payload');const chunks=[];const images=createTaskImageIndex({files:[],pathFor:async()=>'',budgetBytes:8*1048576,maxDefinitions:1000,maxPlacements:10000,chargeBytes(){},onFinding:async()=>{}});
    let normalized;try{normalized=await normalizeTaskInput(valid.value,reader.value,{write:async text=>chunks.push(text),images,limits:{recordBytes:262144,maxRecords:100000,maxImagePlacements:10000}});}finally{await reader.close();}expect(normalized.ok,JSON.stringify(normalized)).toBe(true);const resources=await images.finish();
    const text='{"version":2,"outputFormat":'+JSON.stringify(format)+',"core":'+JSON.stringify({version:rendererIdentity.version,sha256:rendererIdentity.sha256})+',"input":'+chunks.join('')+',"resources":'+JSON.stringify(resources.assets)+'}';await f.write('normalized',text);f.row.normalized_digest=createHash('sha256').update(text).digest('hex');f.row.template_pin.fingerprint=valid.value.fingerprint;f.row.normalization_summary={coreVersion:rendererIdentity.version,coreSha256:rendererIdentity.sha256};const snapshot=makeFontSnapshot(valid.value.fingerprint,f.row.normalized_digest,[],LEGACY_SARABUN);
    const before=taskReadBudget.snapshot().readers,pending=renderTask(f.context,f.row,definition,snapshot,new AbortController().signal);
    if(summaryFailure){await expect(pending).rejects.toMatchObject({code:'DB_RESULT_FAULT'});expect(launches).toBe(1);expect(f.trace).toContain('db-clear');expect(taskReadBudget.snapshot().readers).toBe(before);const bytes=await readFile(await f.context.files.path(f.published.at(-1)));expect(bytes.subarray(0,5).toString()).toBe('%PDF-');await writeFile('/results/app/result-save-failure.json',JSON.stringify({workerLaunches:launches,readerReturnedToBaseline:true,childPidCleared:true,outputBytes:bytes.length,error:'DB_RESULT_FAULT'}));}
    else{const receipt=await pending,bytes=await readFile(await f.context.files.path(receipt.output));expect(bytes.length).toBe(receipt.receipt.byteLength);expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.receipt.sha256);expect(bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');expect(taskReadBudget.snapshot().readers).toBe(before);await writeFile('/results/app/task.'+format,bytes);}
   }finally{await owner?.close();await rm(f.root,{recursive:true,force:true});}
  }
 },45000);
});
