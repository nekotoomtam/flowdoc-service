import {readFile,writeFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {readWorkerConfig} from '../../dist/workers/config.js';
import {createWorkerLauncher} from '../../dist/workers/launcher.js';
export async function prepareP5Lab(){
 if(process.env.FLOWDOC_WORKER_LAB!=='1')throw Error('P5 requires isolated native lab');
 await writeFile('/results/app/coordinator-ready.json',JSON.stringify({pid:process.pid,start:(await readFile('/proc/self/stat','utf8')).split(')')[1].trim().split(/\s+/)[19]}));
 const end=Date.now()+20000;
 while(true){try{const a=JSON.parse(await readFile('/results/public-anchor.json','utf8'));if(a.coordinatorPid===process.pid)break;}catch{}if(Date.now()>end)throw Error('P5 anchor timeout');await new Promise(r=>setTimeout(r,20));}
 return readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json'});
}
export async function prepareP5Launcher(deps={}){
 const config=await prepareP5Lab();
 return createWorkerLauncher(config,{...deps,onGateEvent:event=>{appendFileSync('/results/app/governor-gate-events.jsonl',JSON.stringify(event)+'\n');deps.onGateEvent?.(event);}});
}
