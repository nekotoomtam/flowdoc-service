import {createConnection,type Socket} from 'node:net';
import {workerError} from './contracts.js';
import type {WorkerAnchor} from './config.js';
export const FRAME_BYTES=8192;
export function encodeFrame(value:unknown):Buffer {
 const b=Buffer.from(JSON.stringify(value),'utf8');if(!b.length||b.length>FRAME_BYTES)throw workerError('WORKER_PROTOCOL_ERROR');
 const h=Buffer.allocUnsafe(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b]);
}
export class FrameDecoder {
 private header=Buffer.alloc(0);private body=Buffer.alloc(0);private expected=0;
 constructor(private readonly receive:(value:unknown)=>void){}
 push(chunk:Buffer):void {
  let cursor=0;
  while(cursor<chunk.length){
   if(!this.expected){const n=Math.min(4-this.header.length,chunk.length-cursor);this.header=Buffer.concat([this.header,chunk.subarray(cursor,cursor+n)]);cursor+=n;if(this.header.length<4)continue;
    this.expected=this.header.readUInt32BE();this.header=Buffer.alloc(0);if(this.expected<1||this.expected>FRAME_BYTES)throw workerError('WORKER_PROTOCOL_ERROR');}
   const n=Math.min(this.expected-this.body.length,chunk.length-cursor);this.body=Buffer.concat([this.body,chunk.subarray(cursor,cursor+n)]);cursor+=n;
   if(this.body.length===this.expected){const text=new TextDecoder('utf-8',{fatal:true}).decode(this.body);this.body=Buffer.alloc(0);this.expected=0;this.receive(JSON.parse(text));}
  }
 }
}
type Reply={v:1;id:number;ok:boolean;result?:Record<string,unknown>;code?:string};
/** One live session; no reconnect/re-execution after uncertain transport loss. */
export class BrokerClient {
 private socket:Socket;private ready=false;private sequence=0;private tail:Promise<unknown>=Promise.resolve();
 private pending:{id:number;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}|undefined;
 private epoch='';private capability='';private lostHandlers=new Set<()=>void>();
 private constructor(path:string,private readonly timeoutMs:number){
  this.socket=createConnection(path);const decoder=new FrameDecoder(raw=>{
   const r=raw as Reply,p=this.pending;
   if(!p||!r||r.v!==1||r.id!==p.id||typeof r.ok!=='boolean'||Object.keys(r).some(k=>!['v','id','ok','result','code'].includes(k))||(r.ok&&(!r.result||typeof r.result!=='object'))||(!r.ok&&(typeof r.code!=='string'||!/^WORKER_[A-Z_]+$/.test(r.code))))throw workerError('WORKER_PROTOCOL_ERROR');
   clearTimeout(p.timer);this.pending=undefined;if(r.ok)p.resolve(r.result!);else{p.reject(workerError(r.code!));if(r.code==='WORKER_BROKER_UNAVAILABLE')this.fail(r.code);}
  });
  this.socket.on('data',b=>{try{decoder.push(b);}catch{this.fail('WORKER_PROTOCOL_ERROR');}});
  this.socket.on('error',()=>this.fail('WORKER_BROKER_UNAVAILABLE'));this.socket.on('close',()=>this.fail('WORKER_BROKER_UNAVAILABLE'));
 }
 static async connect(path:string,a:WorkerAnchor,timeoutMs:number):Promise<BrokerClient>{
  const c=new BrokerClient(path,timeoutMs);
  try{
   await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(workerError('WORKER_BROKER_UNAVAILABLE')),timeoutMs);c.socket.once('connect',()=>{clearTimeout(t);resolve();});c.socket.once('error',()=>{clearTimeout(t);reject(workerError('WORKER_BROKER_UNAVAILABLE'));});});
   c.ready=true;const r=await c.call('REGISTER',{instance:a.instance});
   if(typeof r.epoch!=='string'||!/^[a-f0-9]{32}$/.test(r.epoch)||typeof r.capability!=='string'||!/^[a-f0-9]{64}$/.test(r.capability)||r.instance!==a.instance)throw workerError('WORKER_PROTOCOL_ERROR');
   c.epoch=r.epoch;c.capability=r.capability;return c;
  }catch(e){c.close();throw e;}
 }
 get sessionEpoch(){return this.epoch;}
 isReady(){return this.ready;}
 onLost(f:()=>void){this.lostHandlers.add(f);return()=>this.lostHandlers.delete(f);}
 private fail(code:string){
  const was=this.ready;this.ready=false;const p=this.pending;if(p){clearTimeout(p.timer);this.pending=undefined;p.reject(workerError(code));}
  if(!this.socket.destroyed)this.socket.destroy();if(was)for(const f of this.lostHandlers)f();
 }
 call(op:string,payload:Record<string,unknown>={}):Promise<Record<string,unknown>> {
  const run=async()=>{
   if(!this.ready)throw workerError('WORKER_BROKER_UNAVAILABLE');
   return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const id=++this.sequence;const timer=setTimeout(()=>this.fail('WORKER_BROKER_UNAVAILABLE'),this.timeoutMs);
    this.pending={id,resolve,reject,timer};
    try{this.socket.write(encodeFrame({v:1,id,op,...(op==='REGISTER'?{}:{epoch:this.epoch,capability:this.capability}),...payload}));}
    catch{this.fail('WORKER_PROTOCOL_ERROR');}
   });
  };
  const p=this.tail.then(run,run);this.tail=p.catch(()=>{});return p;
 }
 close(){this.fail('WORKER_BROKER_UNAVAILABLE');}
}
