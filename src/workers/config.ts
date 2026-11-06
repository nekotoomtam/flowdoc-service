import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,dirname,parse,normalize} from 'node:path';
import {WORKER_BYTES,AGGREGATE_BYTES,workerError} from './contracts.js';

export type WorkerConfig={mode:'disabled'}|{mode:'required';profile:'1g-2cpu';workerBytes:536870912;aggregateBytes:1073741824;socketPath:string;anchorPath:string;python:string;rpcMs:number;stopMs:number};
export interface WorkerAnchor {v:1;instance:string;coordinatorPid:number;coordinatorStart:string;pidNamespace:string;namespaceRoot:string;serviceUid:number;workerBytes:536870912;aggregateBytes:1073741824}
export function readWorkerConfig(env:NodeJS.ProcessEnv):WorkerConfig {
 const mode=env.FLOWDOC_WORKER_ISOLATION??'disabled';if(mode==='disabled')return {mode};
 if(mode!=='required'||(env.TASK_QUEUE_PROFILE&&env.TASK_QUEUE_PROFILE!=='1g-2cpu'))throw workerError('WORKER_CONFIGURATION_INVALID');
 const socketPath=env.FLOWDOC_WORKER_BROKER_SOCKET??'/run/flowdoc-worker-broker/service.sock',anchorPath=env.FLOWDOC_WORKER_ANCHOR??'/run/flowdoc-worker-broker/anchor.json';
 const python=env.FLOWDOC_WORKER_BOOTSTRAP_PYTHON??'/usr/local/bin/python3.11';
 for(const p of [socketPath,anchorPath,python])if(!isAbsolute(p)||p.includes('\0')||normalize(p)!==p)throw workerError('WORKER_CONFIGURATION_INVALID');
 return {mode,profile:'1g-2cpu',workerBytes:WORKER_BYTES,aggregateBytes:AGGREGATE_BYTES,socketPath,anchorPath,python,rpcMs:5000,stopMs:10000};
}
const allowed=new Set(['TMPDIR','TMP','TEMP','TZ','FLOWDOC_RENDER_TEMP','FONT_STORAGE_DIR','FLOWDOC_TASK_FENCE','FLOWDOC_TASK_RUNTIME','PYTHON_EXECUTABLE']);
/** Never inherit loader/site/preload/database/credential variables into bootstrap. */
export function workerEnvironment(extra:Record<string,string>={}):NodeJS.ProcessEnv {
 const out:NodeJS.ProcessEnv={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'};
 for(const [key,value]of Object.entries(extra)){
  if(!allowed.has(key)||typeof value!=='string'||value.length>4096||value.includes('\0'))throw workerError('WORKER_ENVIRONMENT_INVALID');out[key]=value;
 }
 return out;
}
export function validateWorkerAnchor(raw:unknown):WorkerAnchor {
 const x=raw as WorkerAnchor;const keys=['v','instance','coordinatorPid','coordinatorStart','pidNamespace','namespaceRoot','serviceUid','workerBytes','aggregateBytes'];
 if(!x||typeof x!=='object'||Object.keys(x).sort().join()!==keys.sort().join()||x.v!==1||!/^[a-f0-9]{32}$/.test(x.instance)||!Number.isSafeInteger(x.coordinatorPid)||x.coordinatorPid<1||!/^\d{1,24}$/.test(x.coordinatorStart)||!/^pid:\[\d+\]$/.test(x.pidNamespace)||!Number.isSafeInteger(x.serviceUid)||x.serviceUid<1||x.workerBytes!==WORKER_BYTES||x.aggregateBytes!==AGGREGATE_BYTES||typeof x.namespaceRoot!=='string'||!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(x.namespaceRoot))throw workerError('WORKER_ANCHOR_INVALID');
 return Object.freeze({...x});
}
async function protectedPath(path:string,kind:'file'|'socket'){
 let current=path;
 while(true){
  const st=await lstat(current);const leaf=current===path;
  if(st.isSymbolicLink()||st.uid!==0||(!leaf&&(st.mode&0o022)!==0)||(!leaf&&!st.isDirectory())||(leaf&&kind==='file'&&(!st.isFile()||(st.mode&0o022)!==0))||(leaf&&kind==='socket'&&!st.isSocket()))throw workerError('WORKER_ANCHOR_INVALID');
  if(current===parse(current).root)break;current=dirname(current);
 }
 if(await realpath(path)!==path)throw workerError('WORKER_ANCHOR_INVALID');
}
export async function loadWorkerAnchor(c:Extract<WorkerConfig,{mode:'required'}>):Promise<WorkerAnchor>{
 await protectedPath(c.anchorPath,'file');const b=await readFile(c.anchorPath);if(b.length>4096)throw workerError('WORKER_ANCHOR_INVALID');
 const a=validateWorkerAnchor(JSON.parse(b.toString('utf8')));await protectedPath(c.socketPath,'socket');
 await protectedPath(c.python,'file');return a;
}
