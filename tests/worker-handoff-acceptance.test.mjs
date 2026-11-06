import {describe,beforeAll,afterAll,it,expect} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {prepareP5Launcher} from './helpers/worker-p5-lab.mjs';
describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('P5 native acceptance (FLOWDOC_WORKER_LAB=1)',()=>{
let launcher;
beforeAll(async()=>{launcher=await prepareP5Launcher({resolvePayload:kind=>({executable:process.execPath,args:['/candidate/tests/helpers/worker-payload.mjs',kind]})});},30000);
afterAll(async()=>await launcher?.drain());
it('handles real broker bind denial after ARM expiry without executing a payload or retaining a scope',async()=>{
 const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+25000});await new Promise(r=>setTimeout(r,10500));await expect(h.bind()).rejects.toMatchObject({code:'WORKER_GATE_FAILED'});expect(h.state).toBe('stopped');expect(launcher.isReady()).toBe(true);const events=(await readFile('/results/app/governor-gate-events.jsonl','utf8')).trim().split('\n').map(JSON.parse);expect(events.some(e=>e.pid===h.identity.pid&&e.event==='exec')).toBe(false);
},20000);
it('reaps an actual bound gate crash before allowing subsequent work',async()=>{
 const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await h.bind();const closed=new Promise(r=>h.child.once('close',r));process.kill(h.identity.pid,'SIGKILL');await closed;await expect(h.start()).rejects.toMatchObject({code:'WORKER_GATE_FAILED'});expect(h.state).toBe('stopped');expect(launcher.isReady()).toBe(true);
 const next=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+5000});await next.bind();expect(await next.stop('recovery verified')).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});
});
it('isolates the failed bound lease while a sibling and a subsequent native payload remain usable',async()=>{
 const sibling=await launcher.spawnBlocked({kind:'font-preflight',deadlineAt:Date.now()+15000});await sibling.bind();await sibling.start();sibling.child.stdin.end('hold');let siblingOutput='';sibling.child.stdout.on('data',b=>siblingOutput+=b);
 try{
  const failed=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+10000});await failed.bind();const close=new Promise(r=>failed.child.once('close',r));process.kill(failed.identity.pid,'SIGKILL');await close;await expect(failed.start()).rejects.toMatchObject({code:'WORKER_GATE_FAILED'});expect(await failed.waitStopped()).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});expect(launcher.isReady()).toBe(true);expect(sibling.child.exitCode).toBeNull();expect((await readFile('/proc/'+sibling.identity.pid+'/stat','utf8')).length).toBeGreaterThan(0);
  const next=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+5000});await next.bind();let output='';next.child.stdout.on('data',b=>output+=b);await next.start();next.child.stdin.end('after-crash');expect(await next.waitStopped()).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});expect(JSON.parse(output)).toMatchObject({pid:next.identity.pid,input:'after-crash'});expect(sibling.child.exitCode).toBeNull();await writeFile('/results/app/p501-sibling.json',JSON.stringify({failedPid:failed.identity.pid,siblingPid:sibling.identity.pid,nextPid:next.identity.pid,siblingSurvived:true,nextPayload:true,launcherReady:launcher.isReady()}));
 }finally{expect(await sibling.stop('proof complete')).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});}
},20000);
});
