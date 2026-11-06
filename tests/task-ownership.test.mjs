import {it,expect} from 'vitest';
import {mkdtemp,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn,fork} from 'node:child_process';
import {once} from 'node:events';
const api=await import('../dist/tasks/ownership.js').catch(()=>({}));
const linux=it.runIf(process.platform==='linux');
const temp=()=>mkdtemp(join(tmpdir(),'flowdoc-owner-'));
const remove=async root=>{expect(resolve(root).startsWith(resolve(tmpdir())+sep+'flowdoc-owner-')).toBe(true);await rm(root,{recursive:true,force:true});};
const until=async fn=>{const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw Error('ownership condition timed out');await new Promise(r=>setTimeout(r,20));}};
it('exposes an owned task-store lifetime fence',()=>expect(api.createTaskOwnership).toBeTypeOf('function'));
linux('keeps a stable storage identity and refuses a second live owner',async()=>{
 const root=await temp();let a,b;try{a=await api.createTaskOwnership(root);expect(a.isReady()).toBe(true);await expect(api.createTaskOwnership(root)).rejects.toMatchObject({code:'TASK_STORAGE_BUSY'});const id=a.storageId;await a.close();b=await api.createTaskOwnership(root);expect(b.storageId).toBe(id);expect(b.runtimeId).not.toBe(a.runtimeId);}finally{await b?.close();await a?.close();await remove(root);}
});
linux('stops its registered worker group before releasing the store fence',async()=>{
 const root=await temp();let owner,child;try{owner=await api.createTaskOwnership(root);child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(child,'spawn');const exited=once(child,'exit');await owner.trackChild(child.pid);await owner.close();await exited;const next=await api.createTaskOwnership(root);await next.close();expect(owner.isReady()).toBe(false);}finally{if(child&&child.exitCode===null&&!child.signalCode)process.kill(-child.pid,'SIGKILL');await owner?.close();await remove(root);}
});
linux('reaps a crashed parent\'s registered group before admitting the next owner',async()=>{
 const root=await temp();let parent,next;try{parent=fork(new URL('./taskOwnershipCrash.mjs',import.meta.url),[],{env:{...process.env,TASK_OWNER_TEST_ROOT:root},stdio:['ignore','ignore','ignore','ipc']});const [m]=await once(parent,'message');await expect(api.createTaskOwnership(root)).rejects.toMatchObject({code:'TASK_STORAGE_BUSY'});const exit=once(parent,'exit');parent.kill('SIGKILL');await exit;
 await until(async()=>{try{next=await api.createTaskOwnership(root);return true;}catch(e){if(e.code!=='TASK_STORAGE_BUSY')throw e;return false;}});
 const{groupStopped}=await import('../dist/tasks/workspace.js');expect(await groupStopped(m.childPid,(await import('node:os')).hostname(),(await import('node:os')).hostname())).toBe(true);expect(next.storageId).toBe(m.storageId);
 }finally{if(parent&&parent.exitCode===null&&!parent.signalCode)parent.kill('SIGKILL');await next?.close();await remove(root);}
},10000);
linux('fails readiness when the ownership guardian is lost',async()=>{
 const root=await temp();let owner;try{owner=await api.createTaskOwnership(root);process.kill(owner.pid,'SIGKILL');await until(()=>!owner.isReady());expect(owner.signal.aborted).toBe(true);}finally{await owner?.close();await remove(root);}
});
linux('refuses a linked storage root',async()=>{
 const root=await temp();try{await mkdir(join(root,'target'));await symlink(join(root,'target'),join(root,'link'),'dir');await expect(api.createTaskOwnership(join(root,'link'))).rejects.toHaveProperty('code');}finally{await remove(root);}
});

linux('retains the fence after guardian and parent die while a detached worker survives',async()=>{
 const root=await temp();let parent,next,worker;try{parent=fork(new URL('./taskOwnershipCrash.mjs',import.meta.url),[],{env:{...process.env,TASK_OWNER_TEST_ROOT:root},stdio:['ignore','ignore','ignore','ipc']});const[m]=await once(parent,'message');worker=m.childPid;process.kill(m.guardianPid,'SIGKILL');const exit=once(parent,'exit');parent.kill('SIGKILL');await exit;await expect(api.createTaskOwnership(root)).rejects.toMatchObject({code:'TASK_STORAGE_BUSY'});process.kill(-worker,'SIGKILL');worker=undefined;await until(async()=>{try{next=await api.createTaskOwnership(root);return true;}catch(e){if(e.code!=='TASK_STORAGE_BUSY')throw e;return false;}});
 }finally{if(worker)try{process.kill(-worker,'SIGKILL');}catch{}await next?.close();await remove(root);}
},10000);
linux('native Python retains its own fence and rejects delayed spawns from an old runtime',async()=>{
 const root=await temp();let owner,child,next;try{owner=await api.createTaskOwnership(root);const old=owner.runtimeId,env={...process.env,FLOWDOC_TASK_FENCE:root,FLOWDOC_TASK_RUNTIME:old};child=spawn(new URL('../runtime/python/task_python.py',import.meta.url).pathname,['-c','import time; print("ready",flush=True); time.sleep(30)'],{env,stdio:['ignore','pipe','ignore']});await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw Error('Native fixture exited before ready: '+code);})]);await owner.close();await expect(api.createTaskOwnership(root)).rejects.toMatchObject({code:'TASK_STORAGE_BUSY'});const exit=once(child,'exit');child.kill('SIGKILL');await exit;next=await api.createTaskOwnership(root);const stale=spawn(new URL('../runtime/python/task_python.py',import.meta.url).pathname,['-c','print("unsafe")'],{env,stdio:['ignore','pipe','ignore']});const[code]=await once(stale,'exit');expect(code).toBe(75);
 }finally{child?.kill('SIGKILL');await next?.close();await owner?.close();await remove(root);}
},10000);
