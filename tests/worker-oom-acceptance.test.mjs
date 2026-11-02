import {describe,beforeAll,afterAll,it,expect} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {prepareP5Lab} from './helpers/worker-p5-lab.mjs';
import {createWorkerLauncher} from '../dist/workers/launcher.js';
describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('P5 native acceptance (FLOWDOC_WORKER_LAB=1)',()=>{
let launcher;
beforeAll(async()=>{const c=await prepareP5Lab();launcher=await createWorkerLauncher(c,{resolvePayload:kind=>kind==='legacy-render'?{executable:'/usr/local/bin/python3.11',args:['-I','-S','-c','a=[]\nwhile True: a.append(bytearray(16*1024*1024))']}:kind==='image-prepare'?{executable:'/usr/local/bin/python3.11',args:['-I','-S','-c','import time; time.sleep(30)']}:{executable:'/usr/local/bin/python3.11',args:['/candidate/runtime/python/inspectFont.py','/candidate/node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf']}});},30000);
afterAll(async()=>await launcher?.drain());
it('confines intentional OOM to one 512 MiB worker, preserves coordinator and sibling, and permits native work after teardown',async()=>{
 const sibling=await launcher.spawnBlocked({kind:'image-prepare',deadlineAt:Date.now()+25000});const siblingProof=await sibling.bind();await sibling.start();
 const h=await launcher.spawnBlocked({kind:'legacy-render',deadlineAt:Date.now()+20000}),proof=await h.bind();expect(proof.memoryMax).toBe(536870912);expect(proof.swapMax).toBe(0);
 const closed=new Promise(resolve=>h.child.once('close',(code,signal)=>resolve({code,signal})));await h.start();expect(await closed).toMatchObject({signal:'SIGKILL'});
 const token=randomUUID();await writeFile('/results/app/host-request.json',JSON.stringify({token,action:'inspect-oom',group:proof.group,otherGroup:siblingProof.group,otherPid:sibling.identity.pid,otherStart:sibling.identity.startTime}));const end=Date.now()+10000;let evidence;
 while(true){try{const q=JSON.parse(await readFile('/results/app/host-response.json','utf8'));if(q.token===token){expect(q.ok).toBe(true);evidence=q.proof;break;}}catch(e){if(e.name==='AssertionError')throw e;}if(Date.now()>end)throw Error('OOM evidence timeout');await new Promise(r=>setTimeout(r,20));}
 expect(await h.waitStopped()).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});expect(sibling.child.exitCode).toBeNull();expect(await sibling.stop('proof complete')).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});expect(launcher.isReady()).toBe(true);
 const recovered=await launcher.spawnBlocked({kind:'font-inspect',fontPath:'/candidate/node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf',deadlineAt:Date.now()+10000});await recovered.bind();let result='';recovered.child.stdout.on('data',b=>result+=b);await recovered.start();await recovered.waitStopped();expect(recovered.child.exitCode).toBe(0);expect(JSON.parse(result).names.family).toContain('Sarabun');await writeFile('/results/app/oom-isolation.json',JSON.stringify({evidence,stopProof:true,nativeRecovery:true,syntheticPayload:true,actualJobOomNotProven:true}));
},30000);
});
