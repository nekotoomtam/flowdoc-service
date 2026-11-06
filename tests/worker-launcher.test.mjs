import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {readFile,writeFile,open,mkdir} from 'node:fs/promises';
import {createWorkerLauncher} from '../dist/workers/launcher.js';
import {readWorkerConfig} from '../dist/workers/config.js';
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
describe('worker launcher boundary',()=>{
 it('rejects disabled use rather than silently spawning an unbounded worker',async()=>{
  await expect(createWorkerLauncher(readWorkerConfig({}))).rejects.toMatchObject({code:'WORKER_ISOLATION_DISABLED'});
 });
 it('rejects unavailable required broker before any child',async()=>{
  const c=readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/does-not-exist/service.sock',FLOWDOC_WORKER_ANCHOR:'/does-not-exist/anchor.json'});
  await expect(createWorkerLauncher(c)).rejects.toMatchObject({code:'WORKER_BROKER_UNAVAILABLE'});
 });
});
describe.skipIf(!process.env.FLOWDOC_WORKER_LAB)('real Linux launcher in owned Oracle lab',()=>{
 let launcher,fence,config;
 const resolver=kind=>({executable:process.execPath,args:['/candidate/tests/helpers/worker-payload.mjs',kind]});
 const events=event=>appendFileSync('/results/app/gate-events.log',JSON.stringify(event)+'\n');
 async function host(action,extra={}){
  const token=Date.now()+'-'+Math.random().toString(16).slice(2);await writeFile('/results/app/host-request.json',JSON.stringify({token,action,...extra}));const end=Date.now()+15000;
  while(true){try{const r=JSON.parse(await readFile('/results/app/host-response.json','utf8'));if(r.token===token){expect(r.ok).toBe(true);return r;}}catch{}if(Date.now()>end)throw Error('host action timeout');await new Promise(r=>setTimeout(r,20));}
 }
 async function reset(deps={}){try{await launcher.drain();}catch(e){expect(e.code).toBe('WORKER_STOP_UNCONFIRMED');}await host('restart-broker');launcher=await createWorkerLauncher(config,{resolvePayload:resolver,onGateEvent:events,...deps});}
 beforeAll(async()=>{
  await writeFile('/results/app/coordinator-ready.json',JSON.stringify({pid:process.pid,start:(await readFile('/proc/self/stat','utf8')).split(')')[1].trim().split(/\s+/)[19]}));
  const end=Date.now()+20000;while(true){try{await readFile('/results/public-anchor.json');break;}catch{if(Date.now()>end)throw Error('lab anchor timeout');await new Promise(r=>setTimeout(r,20));}}
  config=readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json'});
  launcher=await createWorkerLauncher(config,{resolvePayload:resolver,onGateEvent:events});
  fence=await open('/results/app/fence','w+');
 },25000);
 afterAll(async()=>{try{await launcher?.drain();}catch(e){expect(e.code).toBe('WORKER_STOP_UNCONFIRMED');}await fence?.close();});
 it('holds a direct child blocked, rejects early input, binds once and preserves PID/stdout',async()=>{
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});const pid=h.child.pid;
  expect(()=>h.child.stdin.write('early')).toThrow();expect(h.state).toBe('blocked');
  expect((await readFile('/proc/'+pid+'/cmdline','utf8')).includes('worker_gate.py')).toBe(true);
  const [a,b]=await Promise.all([h.bind(),h.bind()]);expect(a).toEqual(b);expect(a.memoryMax).toBe(536870912);
  let data='';h.child.stdout.on('data',b=>data+=b);await h.start();h.child.stdin.end('fixture');
  await h.waitStopped();expect(h.child.pid).toBe(pid);expect(JSON.parse(data)).toMatchObject({pid,kind:'legacy-render',input:'fixture',migrationFd:false});
  await expect(h.bind()).rejects.toMatchObject({code:'WORKER_STATE_INVALID'});await expect(h.start()).rejects.toMatchObject({code:'WORKER_STATE_INVALID'});
 });
 it('preserves advanced IPC and exact fence FD4 across gate exec',async()=>{
  const h=await launcher.spawnBlocked({kind:'task-render',fenceFd:fence.fd,fileBytes:10485760,deadlineAt:Date.now()+10000});
  expect(()=>h.child.send({early:true})).toThrow();await h.bind();
  const msg=new Promise((resolve,reject)=>{h.child.once('message',resolve);h.child.once('error',reject);});await h.start();
  h.child.send({bytes:Buffer.from('abc'),big:123n,map:new Map([['x',2]]),array:new Uint16Array([3,4])});
  const r=await msg;expect(r.bytes).toEqual(Buffer.from('abc'));expect(r.big).toBe(123n);expect(r.map).toEqual(new Map([['x',2]]));expect(r.array).toEqual(new Uint16Array([3,4]));expect(r.fenceIno).toBe((await fence.stat()).ino);await h.waitStopped();
 });
 it('cancels before bind without payload and frees only confirmed scopes',async()=>{
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});const p=await h.stop('test');expect(p).toMatchObject({childReaped:true,scopeEmpty:true,groupGone:true});await expect(h.bind()).rejects.toThrow();
 });
 it('cancels a bound worker and does not resurrect after late start',async()=>{
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await h.bind();await h.stop('test');await expect(h.start()).rejects.toThrow();
 });
 it('aborts a running scope with escaped descendants before stop proof',async()=>{
  const abort=new AbortController();const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000,signal:abort.signal});await h.bind();await h.start();
  const ready=new Promise(resolve=>h.child.stdout.once('data',b=>resolve(JSON.parse(b.toString()))));h.child.stdin.end('hold');const info=await ready;expect(info.escapedPid).toBeGreaterThan(0);abort.abort();expect(await h.waitStopped()).toMatchObject({scopeEmpty:true,childReaped:true});
 });
 it('does not inherit malicious parent loader variables',async()=>{
  const before=process.env.LD_PRELOAD;process.env.LD_PRELOAD='/not-a-real-loader.so';let h;
  try{h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});}finally{if(before===undefined)delete process.env.LD_PRELOAD;else process.env.LD_PRELOAD=before;}
  await h.bind();let data='';h.child.stdout.on('data',b=>data+=b);await h.start();h.child.stdin.end('env');await h.waitStopped();expect(JSON.parse(data).unsafeEnvironment).toBe(false);
 });
 it('drains an in-flight ARM without creating a child after admission closes',async()=>{
  const before=await readFile('/proc/self/task/'+process.pid+'/children','utf8');const pending=launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});const drained=launcher.drain();await expect(pending).rejects.toMatchObject({code:'WORKER_BROKER_UNAVAILABLE'});await drained;expect(await readFile('/proc/self/task/'+process.pid+'/children','utf8')).toBe(before);await reset();
 });
 it('waits for a child still acquiring identity when drain starts',async()=>{
  let drained;await reset({spawnChild:(exe,args,opts)=>{const child=spawn(exe,args,opts);child.once('spawn',()=>{drained=launcher.drain();});return child;}});
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await drained;expect(h.state).toBe('stopped');await reset();
 });
 it('times out a silent gate and reaps it without poisoning confirmed cleanup',async()=>{
  await reset({spawnChild:(exe,args,options)=>spawn(exe,[...args.slice(0,2),'/candidate/tests/helpers/worker-fault-gate.py','silent'],options)});
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+12000});await expect(h.bind()).rejects.toMatchObject({code:'WORKER_DEADLINE'});expect(h.state).toBe('stopped');expect(launcher.isReady()).toBe(true);
 },15000);
 it('rejects a forged bind receipt against kernel placement and becomes unready',async()=>{
  await reset({spawnChild:(exe,args,options)=>spawn(exe,[...args.slice(0,2),'/candidate/tests/helpers/worker-fault-gate.py','forged'],options)});
  const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await expect(h.bind()).rejects.toMatchObject({code:'WORKER_BIND_INVALID'});expect(h.state).toBe('stopped');expect(launcher.isReady()).toBe(false);
 });
 it('executes the fixed default legacy entry without a fixture payload adapter',async()=>{
  await reset();await launcher.drain();await host('restart-broker');launcher=await createWorkerLauncher(config,{onGateEvent:events});
  await mkdir('/results/app/default-entry',{recursive:true});const h=await launcher.spawnBlocked({kind:'legacy-render',env:{FLOWDOC_RENDER_TEMP:'/results/app/default-entry'},deadlineAt:Date.now()+10000});await h.bind();await h.start();h.child.stdin.end('invalid input');await h.waitStopped();expect(h.child.exitCode).toBe(1);
 });
 it('loses readiness on broker crash and retains an unconfirmed stop instead of reconnecting',async()=>{
  await reset();const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await h.bind();await host('kill-broker');await new Promise(r=>setTimeout(r,30));expect(launcher.isReady()).toBe(false);await expect(h.stop('broker lost')).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});await expect(launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+5000})).rejects.toMatchObject({code:'WORKER_BROKER_UNAVAILABLE'});
 });
 it('closes an unclaimed bootstrap immediately when the broker disappears',async()=>{
  await reset();const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+60000});await host('kill-broker');const end=Date.now()+1500;while(true){try{await readFile('/proc/'+h.child.pid+'/stat');}catch{break;}if(Date.now()>end)throw Error('orphan bootstrap');await new Promise(r=>setTimeout(r,10));}await expect(h.stop('lost')).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});
 });
 it('retains unconfirmed startup teardown even before a handle was registered',async()=>{
  await reset({readChildStart:async()=>{await host('kill-broker');throw Error('fixture startup interrupted');}});
  await expect(launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000})).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});await expect(launcher.drain()).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});
 });
});
