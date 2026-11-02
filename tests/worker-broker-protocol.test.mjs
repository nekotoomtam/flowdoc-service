import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readWorkerConfig,workerEnvironment,validateWorkerAnchor} from '../dist/workers/config.js';
import {encodeFrame,FrameDecoder} from '../dist/workers/broker-client.js';
describe('worker configuration and transport',()=>{
 it('defaults disabled; required has fixed profile and immutable hard caps',()=>{
  expect(readWorkerConfig({})).toEqual({mode:'disabled'});
  const c=readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required'});
  expect(c).toMatchObject({mode:'required',workerBytes:536870912,aggregateBytes:1073741824,profile:'1g-2cpu'});
  expect(()=>readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'maybe'})).toThrow();
  expect(()=>readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',TASK_QUEUE_PROFILE:'4g-2cpu'})).toThrow();
 });
 it('builds a minimal environment, rejects loader injection and unknown keys',()=>{
  for(const key of ['LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH','PYTHONHOME','NODE_OPTIONS','BASH_ENV'])expect(()=>workerEnvironment({[key]:'/bad'})).toThrow();
  expect(workerEnvironment({TMPDIR:'/tmp/case',FLOWDOC_TASK_RUNTIME:'runtime'})).toMatchObject({TMPDIR:'/tmp/case',FLOWDOC_TASK_RUNTIME:'runtime'});
  expect(workerEnvironment({})).not.toHaveProperty('LD_PRELOAD');expect(workerEnvironment({})).not.toHaveProperty('DATABASE_URL');
 });
 it('rejects malformed anchors and unsupported limits',()=>{
  const a={v:1,instance:'a'.repeat(32),coordinatorPid:1,coordinatorStart:'123',pidNamespace:'pid:[123]',namespaceRoot:'/owned-runtime',serviceUid:10001,workerBytes:536870912,aggregateBytes:1073741824};
  expect(validateWorkerAnchor(a)).toEqual(a);
  for(const change of [{workerBytes:1073741824},{namespaceRoot:'/../escape'},{coordinatorPid:0},{extra:true}])expect(()=>validateWorkerAnchor({...a,...change})).toThrow();
 });
 it('decodes fragmented/coalesced frames and bounds memory before parsing',()=>{
  const got=[];const d=new FrameDecoder(v=>got.push(v));const frame=encodeFrame({v:1,id:1,ok:true});
  for(const x of frame)d.push(Buffer.from([x]));d.push(Buffer.concat([frame,frame]));expect(got).toHaveLength(3);
  expect(()=>new FrameDecoder(()=>{}).push(Buffer.from([0,0,32,1]))).toThrow();
  expect(()=>encodeFrame({data:'x'.repeat(8192)})).toThrow();
  expect(()=>new FrameDecoder(()=>{}).push(Buffer.from([0,0,0,2,0xff,0xff]))).toThrow();
 });
 it('bounds pending slots, terminal cache and rejects evicted replay in Python broker policy',()=>{
  const r=spawnSync('python',['-I','-S','tests/helpers/worker-broker-policy.py'],{encoding:'utf8',timeout:15000});
  expect(r.status,r.stderr||r.stdout).toBe(0);expect(r.stdout).toContain('POLICY_PASS');
 });
});
