import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {writeFile} from 'node:fs/promises';
export const pdf=Buffer.from([37,80,68,70,45,49,46,55,10,0,128,255,10]);
export function fakeLauncher({holdBind,holdStop,unknown=false,mode='pdf',exitCode=0,issues}={}){
 const trace=[],handles=[];
 const launcher={isReady:()=>true,closeAdmissions(){},async drain(){},async spawnBlocked(spec){
  trace.push(['spawn',spec]);const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{throw Error('adapter must use launcher stop');};
  let state='blocked';const close=()=>{if(state==='closed')return;state='closed';child.emit('close',exitCode);};
  const h={child,identity:{pid:123,pgid:123,startTime:'1'},get state(){return state;},async bind(){trace.push(['bind']);await holdBind;state='bound';},async start(){trace.push(['start']);state='started';},async stop(){trace.push(['stop']);if(unknown)throw Object.assign(Error(),{code:'WORKER_STOP_UNCONFIRMED'});await holdStop;return{childReaped:true,groupGone:true,scopeEmpty:true};},async waitStopped(){return h.stop();}};
  child.stdin.on('data',b=>{if(state!=='started')throw Error('early input');trace.push(['stdin',Buffer.from(b).toString()]);});
  child.stdin.on('end',async()=>{if(mode==='silent')return;if(issues)await writeFile(spec.env.FLOWDOC_RENDER_TEMP+'/issues.json',JSON.stringify(issues));child.stdout.write(pdf);child.stdout.end();close();});
  child.send=(message,callback)=>{if(state!=='started')throw Error('early IPC');trace.push(['send',message]);void(async()=>{await writeFile(message.output,'png');child.emit('message',{ok:true,width:10,height:10,byteSize:3,effectiveDpi:72,mediaType:'image/png'});callback?.();close();})();};
  handles.push(h);return h;
 }};return{launcher,trace,handles};
}
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
