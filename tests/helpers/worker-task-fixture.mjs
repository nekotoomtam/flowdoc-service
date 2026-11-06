import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export async function fixture({launcher,holdBind,holdStop,unknown=false,pidFailure=false,summaryFailure=false}={}){
 const root=await mkdtemp(join(tmpdir(),'p3-task-')),work=join(root,'work');await mkdir(work);const trace=[],id=randomUUID();
 const row={id,resource_policy:{stopMs:50,processMs:10000,memoryPauseBytes:1e9,memoryStopBytes:1e9,pdfBytes:52428800,docxBytes:33554432,imageBytes:52428800,findingDetails:20},normalized_file_id:'normalized',lease_token:'lease',output_format:'pdf',normalization_version:1,normalized_digest:'digest',normalization_summary:{coreVersion:'0.5.2',coreSha256:'pin'},template_pin:{fingerprint:'fingerprint'}};
 const snapshot={bindings:[]},published=[];let used=0;const query=async(sql,args)=>{
  if(sql.includes('SELECT storage_used_bytes'))return{rows:[{storage_used_bytes:used}]};
  if(sql.includes("role='original_image'"))return{rows:[]};
  if(sql.includes('SELECT storage_key FROM task_files'))return{rows:[{storage_key:'normalized'}]};
  if(sql.includes('UPDATE tasks SET child_pid=$2')){trace.push('db-pid');if(pidFailure)throw Object.assign(Error('DB PID save failure'),{code:'DB_FAULT'});}
  if(sql.includes('UPDATE tasks SET child_pid=NULL'))trace.push('db-clear');
  if(sql.includes('UPDATE tasks SET generation_summary')&&summaryFailure)throw Object.assign(Error('DB result save failure'),{code:'DB_RESULT_FAULT'});
  if(sql.includes('storage_used_bytes=storage_used_bytes+$2'))used+=args[1];
  return{rows:[],rowCount:1};
 };const pool={query,connect:async()=>({query,release(){}})};
 const files={workspace:async()=>work,path:async key=>join(root,key),async open(key){const p=join(root,key);await mkdir(dirname(p),{recursive:true});return open(p,'wx',0o600);},async publish(key){const target=key.replace(/\.part$/,'');await rename(join(root,key),join(root,target));published.push(target);return target;}};
 const owner={directory:root,runtimeId:'runtime',fenceFd:4,isReady:()=>true,trackChild:async()=>trace.push('track'),untrackChild:async()=>trace.push('untrack')};
 const context={pool,files,repo:{reserve:async()=>trace.push('reserve'),row:async()=>row,live(){}},resources:{holds:()=>true,memoryLimits:{pauseBytes:1e9,stopBytes:1e9}},ownership:owner};
 const child=new EventEmitter();child.pid=123456;child.connected=true;let closed=false,state='blocked';const close=()=>{if(closed)return;closed=true;child.connected=false;child.emit('close',1);};
 child.send=(m,cb)=>{trace.push(m.type==='init'?'init':'ack');cb?.();if(m.type==='init')queueMicrotask(close);};
 const handle={child,identity:{pid:child.pid,pgid:child.pid,startTime:'1'},get state(){return state;},async bind(){trace.push('bind');await holdBind;if(closed)throw Error('stopped');state='bound';},async start(){trace.push('start');state='started';},async stop(){trace.push('stop');if(unknown)throw Object.assign(Error(),{code:'WORKER_STOP_UNCONFIRMED'});await holdStop;close();state='stopped';return{childReaped:true,groupGone:true,scopeEmpty:true};},async waitStopped(){return handle.stop();}};
 context.workerLauncher=launcher??{isReady:()=>true,spawnBlocked:async spec=>{trace.push('spawn');context.launchSpec=spec;return handle;},closeAdmissions(){},async drain(){}};
 return{root,work,row,snapshot,trace,context,handle,published,write:async(key,text)=>writeFile(join(root,key),text)};
}
