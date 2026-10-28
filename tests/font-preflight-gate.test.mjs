import {it,expect} from 'vitest';
const api=await import('../dist/fonts/preflight-gate.js').catch(()=>({}));
it('provides a bounded cancellable native preflight gate',()=>expect(api.createFontPreflightGate).toBeTypeOf('function'));
it('uses worker credits, rejects concurrent native checks and releases after confirmation',async()=>{
 const holds=new Set();let credit=0,stop;const gate=api.createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:(id,r)=>{holds.add(id);credit+=320;stop=r.onStop;return{release(){holds.delete(id);credit-=320;}};}});const client={query:async()=>({rows:[{locked:true}]})};let entered,finish;const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r);const run=gate.run(client,undefined,async signal=>{entered();await wait;signal.throwIfAborted();return 42;});await started;expect(credit).toBe(320);await expect(gate.run(client,undefined,async()=>0)).rejects.toMatchObject({code:'UNAVAILABLE'});stop('RESOURCE_LIMIT');expect(credit).toBe(320);finish();await expect(run).rejects.toMatchObject({code:'UNAVAILABLE'});expect(credit).toBe(0);expect(holds.size).toBe(0);expect(await gate.run(client,undefined,async()=>43)).toBe(43);await gate.stop();
});
it('fails closed and retains worker credit when stopping is unconfirmed',async()=>{
 let released=0;const gate=api.createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>({release(){released++;}})});await expect(gate.run({query:async()=>({rows:[{locked:true}]})},undefined,async()=>{throw Object.assign(Error(),{code:'WORKER_STOP_UNCONFIRMED'});})).rejects.toMatchObject({code:'UNAVAILABLE'});expect(released).toBe(0);expect(gate.isReady()).toBe(false);await expect(gate.stop()).rejects.toMatchObject({code:'UNAVAILABLE'});
});
it('does not start native work without shared memory headroom or a database preflight permit',async()=>{
 let calls=0;for(const [locked,grant] of [[true,null],[false,{release(){}}]]){const gate=api.createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>grant});await expect(gate.run({query:async()=>({rows:[{locked}]})},undefined,async()=>calls++)).rejects.toMatchObject({code:'UNAVAILABLE'});await gate.stop();}expect(calls).toBe(0);
});

it('bounds waiting outside database work and removes cancelled waiters before execution',async()=>{
 const gate=api.createFontPreflightGate();let entered,release,calls=0;const start=new Promise(r=>entered=r),held=new Promise(r=>release=r);const first=gate.admit(undefined,1,async()=>{calls++;entered();await held;return 1;});await start;const abort=new AbortController();const second=gate.admit(abort.signal,1,async()=>calls++);await expect(gate.admit(undefined,1,async()=>calls++)).rejects.toMatchObject({code:'QUEUE_FULL'});expect(calls).toBe(1);abort.abort();await expect(second).rejects.toMatchObject({code:'UNAVAILABLE'});release();expect(await first).toBe(1);expect(await gate.admit(undefined,1,async()=>2)).toBe(2);expect(calls).toBe(1);await gate.stop();
});
