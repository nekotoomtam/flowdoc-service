import{it,expect}from'vitest';
const config=await import('../dist/tasks/queue-profile.js').catch(()=>({}));
const {createQueueResources}=await import('../dist/tasks/queue-resources.js');
const {queuePolicy,policyWith,QUEUE_POLICY_VERSION}=await import('../dist/tasks/policy.js');
const MiB=1048576,until=async f=>{const end=Date.now()+2000;while(!f()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,5));}};
it('provides an explicit profile selector without changing the default',()=>{
 expect(config.readTaskQueueConfig).toBeTypeOf('function');
 expect(config.readTaskQueueConfig({})).toMatchObject({maxOutstanding:10,profile:{name:'1g-2cpu',memoryBytes:1024*MiB,maxOutstanding:10}});
});
it('accepts only bounded explicit6GiB settings and rejects unknown profiles',()=>{
 expect(config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'20'})).toMatchObject({maxOutstanding:20,profile:{name:'6g-2cpu',memoryBytes:6144*MiB,maxOutstanding:20}});
 for(const env of [{TASK_QUEUE_PROFILE:'other'},{TASK_QUEUE_MAX_OUTSTANDING:'11'},{TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'21'},{TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'15'},{TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'0'},{TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'10.5'}])expect(()=>config.readTaskQueueConfig(env)).toThrow();
});
it('uses one shared legacy/task ceiling in6GiB mode and rejects conflicting explicit legacy settings',()=>{
 const q=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'20'});
 expect(config.queueAdmissionLimit(10,q)).toBe(20);expect(config.queueAdmissionLimit(30,config.readTaskQueueConfig({}))).toBe(30);
 expect(()=>config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu',TASK_QUEUE_MAX_OUTSTANDING:'10',JOB_MAX_OUTSTANDING:'20'})).toThrow();
});
it('pins the6GiB policy version and20 outstanding tasks without raising document limits',()=>{
 const original=policyWith({maxOutstanding:20});const p=queuePolicy(original,config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile);
 expect(p).toMatchObject({version:'task-v1-queue-6g-2cpu-trial-1',maxTasks:20,maxOwnerTasks:20,maxOutstanding:20,memoryPauseBytes:4608*MiB,memoryStopBytes:5376*MiB});
 expect(p.jsonBytes).toBe(original.jsonBytes);expect(p.pdfBytes).toBe(original.pdfBytes);expect(p.docxBytes).toBe(original.docxBytes);expect(p.poolBytes).toBe(original.poolBytes);
 expect(policyWith(p)).toMatchObject({version:p.version,memoryPauseBytes:p.memoryPauseBytes,memoryStopBytes:p.memoryStopBytes});
 expect(()=>policyWith({...p,version:QUEUE_POLICY_VERSION})).toThrow();
 expect(queuePolicy(original)).toMatchObject({version:QUEUE_POLICY_VERSION,maxTasks:10,maxOutstanding:10});
});
it('parses finite CPU quotas and requires exactly2CPUs for the explicit profile',async()=>{
 expect(config.parseQueueCpuLimit('200000 100000')).toBe(2);expect(config.parseQueueCpuLimit('max 100000')).toBeNull();
 const profile=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile;
 await expect(createQueueResources({profile,readCpuLimit:async()=>1,readMemory:async()=>({current:100*MiB,max:6144*MiB})})).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(createQueueResources({profile,readCpuLimit:async()=>2,readMemory:async()=>({current:100*MiB,max:1024*MiB})})).rejects.toMatchObject({code:'UNAVAILABLE'});
});
it('keeps two workers and two intakes while using the6GiB global headroom',async()=>{
 const profile=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile;
 const r=await createQueueResources({profile,readCpuLimit:async()=>2,readMemory:async()=>({current:1024*MiB,max:6144*MiB}),sampleMs:10});
 const grants=[];try{
  for(const[id,kind]of[['w1','worker'],['w2','worker'],['i1','intake'],['i2','intake']])grants.push(await r.acquire(id,{kind,order:0,expiresAt:Date.now()+5000}));
  expect(r.snapshot()).toMatchObject({workers:2,intakes:2});expect(r.tryAcquire('w3',{kind:'worker',order:1,expiresAt:Date.now()+5000})).toBeNull();
  expect(r.memoryLimits).toEqual({pauseBytes:4608*MiB,stopBytes:5376*MiB});
 }finally{for(const g of grants)g.release();await r.stop();}
});
it('bounds resource waiters at20 and releases all aborted waiters',async()=>{
 const profile=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile;
 const r=await createQueueResources({profile,readCpuLimit:async()=>2,readMemory:async()=>({current:4700*MiB,max:6144*MiB}),sampleMs:10});const a=new AbortController();
 try{const pending=Array.from({length:20},(_,n)=>r.acquire('t'+n,{kind:'intake',order:n,expiresAt:Date.now()+5000,signal:a.signal}).catch(e=>e));await expect(r.acquire('extra',{kind:'intake',order:21,expiresAt:Date.now()+5000})).rejects.toMatchObject({code:'QUEUE_FULL'});expect(r.snapshot().waiters).toBe(20);a.abort();await Promise.all(pending);expect(r.snapshot().waiters).toBe(0);}finally{await r.stop();}
});
it('uses6GiB pressure hysteresis before granting new work',async()=>{
 const profile=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile;let memory=5100*MiB,g;
 const r=await createQueueResources({profile,readCpuLimit:async()=>2,readMemory:async()=>({current:memory,max:6144*MiB}),sampleMs:10});
 try{const pending=r.acquire('test',{kind:'intake',order:0,expiresAt:Date.now()+5000}).then(x=>g=x);memory=4200*MiB;await new Promise(r=>setTimeout(r,35));expect(g).toBeUndefined();await pending;expect(r.snapshot().pressure).toBe(false);g.release();}finally{await r.stop();}
});
it('stops the newest worker at6GiB emergency pressure without releasing its credit early',async()=>{
 const profile=config.readTaskQueueConfig({TASK_QUEUE_PROFILE:'6g-2cpu'}).profile;let memory=100*MiB;const victims=[];
 const r=await createQueueResources({profile,readCpuLimit:async()=>2,readMemory:async()=>({current:memory,max:6144*MiB}),sampleMs:10});let a,b;
 try{a=await r.acquire('old',{kind:'worker',order:0,expiresAt:Date.now()+5000,onStop:c=>victims.push(['old',c])});b=await r.acquire('new',{kind:'worker',order:1,expiresAt:Date.now()+5000,onStop:c=>victims.push(['new',c])});memory=5400*MiB;await until(()=>victims.length===1);expect(victims).toEqual([['new','RESOURCE_LIMIT']]);expect(r.snapshot().workers).toBe(2);b.release();b=undefined;await until(()=>victims.length===2);}finally{a?.release();b?.release();await r.stop();}
});
