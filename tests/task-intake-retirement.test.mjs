import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,readdir,rm,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
const state=vi.hoisted(()=>({rows:new Map(),gets:0,retiredGets:0,sequence:0}));
vi.mock('../dist/templates/registry.js',()=>({loadTemplate:async()=>({ok:true,value:{versionId:'version',template:{fingerprint:'pin',definition:{version:1}}}})}));
vi.mock('../dist/tasks/repository.js',async original=>({...(await original()),taskRepository:()=>({
 async create(){const id='10000000-0000-4000-8000-'+String(++state.sequence).padStart(12,'0'),now=new Date();const row={id,status:'awaiting_input',created_by_principal:'p',owner_key:'o',created_at:now,expires_at:new Date(+now+3600000),template_pin:{},cleanup_status:'not_due',resource_policy:{requestBytes:1024,maxParts:2,idleMs:60000,receiveMs:60000,leaseMs:30000,maxIndexBytes:1024},lease_token:'lease'};state.rows.set(id,row);return row;},
 async get(id){state.gets++;const row=state.rows.get(id);if(row?.cleanup_status==='done')state.retiredGets++;return row;},
 async row(_c,id){return state.rows.get(id);},live(){},async event(){},async renew(){return true;},
 async claim(id){const r=state.rows.get(id);r.status='receiving';return r;},
 async finish(id,reason){const r=state.rows.get(id);r.status='failed';r.terminal_reason=reason;return r;}
})}));
import {createTaskIntake} from '../dist/tasks/intake.js';
let root,intake;
const pool={async connect(){return{query:pool.query,release(){}};},async query(sql,args=[]){
 if(sql.startsWith('SELECT storage_held_bytes'))return {rows:[{storage_held_bytes:'16777216'}]};
 if(sql.startsWith('UPDATE tasks SET cleanup_status=')){const r=state.rows.get(args[0]);r.cleanup_status=args.length>1?args[1]:'running';}
 return{rows:[],rowCount:0};
}};
const opening={authorization:'Bearer audit',docKey:'test',contentType:'multipart/form-data; boundary=audit'};
beforeEach(async()=>{state.rows.clear();state.gets=state.retiredGets=state.sequence=0;root=await mkdtemp(join(tmpdir(),'flowdoc-retirement-'));intake=await createTaskIntake({pool,root,resolveCredential:()=>({ownerKey:'o',principalId:'p',docKeys:['test'],taskRead:true}),queueResources:{readMemory:async()=>({current:100*1048576,max:1024*1048576})}});});
afterEach(async()=>{await intake.stop();expect(resolve(root).startsWith(resolve(tmpdir())+sep+'flowdoc-retirement-')).toBe(true);await rm(root,{recursive:true,force:true});});
it('does not retain terminal task IDs for shutdown after repeated open/fail cycles',async()=>{
 for(let n=0;n<25;n++){const t=await intake.open(opening);await intake.fail(t.taskId,'CONNECTION_LOST');}
 state.gets=0;await intake.stop();expect(state.gets).toBe(0);
});
it('still interrupts an outstanding opened task on shutdown',async()=>{
 const t=await intake.open(opening);await intake.stop();expect(state.rows.get(t.taskId)).toMatchObject({status:'failed',terminal_reason:'WORKER_INTERRUPTED'});
});
it('hands receiving ownership to the active receiver without a historical shutdown lookup',async()=>{
 const t=await intake.open(opening),source=new Readable({read(){}});
 const received=intake.receive({...opening,taskId:t.taskId,body:source}).catch(e=>e);
 const deadline=Date.now()+1000;while(!intake.processingContext.active.has(t.taskId)){if(Date.now()>deadline)throw Error('receiver did not claim');await new Promise(r=>setTimeout(r,1));}
 await intake.stop();expect((await received).code).toBe('WORKER_INTERRUPTED');expect(state.retiredGets).toBe(0);
});
it('retires all directories only after terminal cleanup, and repeated cleanup creates none',async()=>{
 const t=await intake.open(opening);await intake.fail(t.taskId,'CONNECTION_LOST');
 expect(state.rows.get(t.taskId).cleanup_status).toBe('done');expect(await readdir(root)).toEqual([]);
 await intake.processingContext.cleanup(t.taskId);expect(await readdir(root)).toEqual([]);
});
it('retains resources and retry status if an unexpected file prevents empty-tree removal',async()=>{
 const t=await intake.open(opening);await mkdir(join(root,t.taskId));await writeFile(join(root,t.taskId,'unknown'),'preserve');
 await intake.fail(t.taskId,'CONNECTION_LOST');expect(state.rows.get(t.taskId).cleanup_status).toBe('retry_needed');
 expect(await readdir(join(root,t.taskId))).toContain('unknown');
});
it('does not retire a terminal task directory while an active owner still holds it',async()=>{
 const t=await intake.open(opening),r=state.rows.get(t.taskId);r.status='failed';
 await mkdir(join(root,t.taskId));await writeFile(join(root,t.taskId,'sentinel'),'active');
 intake.processingContext.active.set(t.taskId,{abort:new AbortController(),done:Promise.resolve()});
 try{await intake.processingContext.cleanup(t.taskId);expect(await readdir(join(root,t.taskId))).toEqual(['sentinel']);}finally{intake.processingContext.active.delete(t.taskId);}
});
