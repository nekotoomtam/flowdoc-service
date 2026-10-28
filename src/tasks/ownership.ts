import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir,lstat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {taskError} from './quota.js';
export interface TaskOwnership {
 readonly directory:string;readonly fenceFd:number;readonly runtimeId:string;readonly storageId:string;readonly pid:number;readonly signal:AbortSignal;
 isReady():boolean;trackChild(pid:number):Promise<void>;untrackChild(pid:number):Promise<void>;close():Promise<void>;
}
export async function createTaskOwnership(directory:string):Promise<TaskOwnership>{
 if(process.platform!=='linux')throw taskError('TASK_OWNER_UNAVAILABLE');
 const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});const st=await lstat(root);if(!st.isDirectory()||st.isSymbolicLink())throw taskError('STORAGE_IO');
 const fence=await open(resolve(root,'.writers.lock'),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);if(!(await fence.stat()).isFile()){await fence.close();throw taskError('STORAGE_IO');}
 const child=spawn(process.env.PYTHON_EXECUTABLE??'python',[fileURLToPath(new URL('../../runtime/python/task_owner.py',import.meta.url)),root],{stdio:['pipe','pipe','ignore',fence.fd],windowsHide:true});
 const lost=new AbortController(),pending=new Map<number,{resolve:()=>void;reject:(e:unknown)=>void;timer:NodeJS.Timeout}>();
 let ready=false,closed=false,closing=false,sequence=0,identity:{runtimeId:string;storageId:string}|undefined,closePromise:Promise<void>|undefined;
 let readyResolve!:()=>void,readyReject!:(e:unknown)=>void,closedResolve!:()=>void;
 const started=new Promise<void>((res,rej)=>{readyResolve=res;readyReject=rej;}),exited=new Promise<void>(res=>{closedResolve=res;});
 const fail=(code='TASK_OWNER_UNAVAILABLE')=>{ready=false;const error=taskError(code);lost.abort(error);readyReject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 const lines=createInterface({input:child.stdout!});
 lines.on('line',line=>{try{if(line.length>1024)throw Error();const m=JSON.parse(line);
  if(m.event==='busy'){fail('TASK_STORAGE_BUSY');return;}
  if(m.event==='ready'){
   const uuid=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
   if(identity||!uuid.test(m.runtimeId)||!uuid.test(m.storageId))throw Error();identity={runtimeId:m.runtimeId,storageId:m.storageId};ready=true;readyResolve();return;
  }
  if(m.ack){const p=pending.get(m.ack);if(!p)throw Error();pending.delete(m.ack);clearTimeout(p.timer);m.error?p.reject(taskError('TASK_OWNER_UNAVAILABLE')):p.resolve();return;}
  throw Error();
 }catch{fail();}});
 child.on('error',()=>fail());child.stdin!.on('error',()=>fail());child.once('close',()=>{closed=true;fail();lines.close();closedResolve();});
 const startup=setTimeout(()=>{fail();child.stdin!.end();},5000);
 try{await started;}catch(e){child.stdin!.end();await exited;await fence.close();throw e;}finally{clearTimeout(startup);}
 const request=(op:string,pid?:number):Promise<void>=>{
  if(!ready||closed)return Promise.reject(taskError('TASK_OWNER_UNAVAILABLE'));
  const id=++sequence;return new Promise((res,rej)=>{const timer=setTimeout(()=>{pending.delete(id);fail();rej(taskError('TASK_OWNER_UNAVAILABLE'));child.stdin!.end();},8000);pending.set(id,{resolve:res,reject:rej,timer});child.stdin!.write(JSON.stringify({id,op,...(pid===undefined?{}:{pid})})+'\n',error=>{if(error)fail();});});
 };
 return {...identity!,directory:root,fenceFd:fence.fd,pid:child.pid!,signal:lost.signal,isReady:()=>ready&&!closing&&!closed,
  trackChild:pid=>request('register',pid),untrackChild:pid=>request('unregister',pid),
  close(){return closePromise??=(async()=>{closing=true;if(!closed&&ready)await request('stop');child.stdin!.end();await exited;await fence.close();})();}
 };
}
