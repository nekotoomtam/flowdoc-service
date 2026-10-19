import {open,lstat} from 'node:fs/promises';
import type {TaskValue} from '@flowdoc/core';
import {taskReadBudget,type ReadGrant} from './read-cache-budget.js';
import {taskReadWindows,type ReadAt} from './read-cache.js';
import {fieldIndex} from './field-index.js';
const invalid=()=>Object.assign(Error('Invalid staged JSON'),{code:'INVALID_DATA'});
/** Read-only byte ranges; no container is decoded or retained as a JS object. */
export async function openTaskJson(path:string,signal?:AbortSignal,options:{grant?:ReadGrant;readAt?:ReadAt}={}){
 const grant=options.grant??await taskReadBudget.acquire('standalone',signal,false);let source:ReturnType<typeof taskReadWindows>,size=0;
 const index=fieldIndex(grant.indexBytes,()=>source.check());
 grant.claim();
 try{signal?.throwIfAborted();const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw invalid();const file=await open(path,'r');
 try{const actual=await file.stat();if(actual.dev!==st.dev||actual.ino!==st.ino||actual.size!==st.size)throw invalid();size=st.size;source=taskReadWindows(file,actual,grant,signal,options.readAt,index.close,()=>({...index.stats}));}catch(e){await file.close();throw e;}
 }catch(e){grant.release();throw e;}
 class Cursor{
  pos:number;constructor(pos:number){this.pos=pos;}
  byte(){return source.byte(this.pos);}
  async space(){while([9,10,13,32].includes(await this.byte()))this.pos++;}
  async string(){const start=this.pos;if(await this.byte()!==34)throw invalid();this.pos++;let escaped=false;while(true){const b=await this.byte();if(b<0||b<32)throw invalid();this.pos++;if(this.pos-start>393218)throw invalid();if(!escaped&&b===34)return;if(!escaped&&b===92)escaped=true;else escaped=false;}}
  async skip(depth=0):Promise<void>{if(depth>64)throw invalid();await this.space();const b=await this.byte();if(b===34){await this.string();return;}if(b===123||b===91){this.pos++;await this.space();const end=b===123?125:93;if(await this.byte()===end){this.pos++;return;}while(true){if(b===123){await this.string();await this.space();if(await this.byte()!==58)throw invalid();this.pos++;}await this.skip(depth+1);await this.space();const sep=await this.byte();this.pos++;if(sep===end)return;if(sep!==44)throw invalid();await this.space();}}else{const start=this.pos;while(![-1,9,10,13,32,44,93,125].includes(await this.byte())){this.pos++;if(this.pos-start>128)throw invalid();}if(this.pos===start)throw invalid();const v=JSON.parse(await source.text(start,this.pos));if(v!==null&&typeof v==='object')throw invalid();}}
 }
 const read=source.text;
 class Value implements TaskValue{
  constructor(readonly start:number,readonly end:number){}
  async byteLength(){source.check();return this.end-this.start;}
  async kind():Promise<'object'|'array'|'scalar'>{const c=new Cursor(this.start),b=await c.byte();return b===123?'object':b===91?'array':'scalar';}
  async scalar(){if(await this.kind()!=='scalar'||this.end-this.start>393218)throw invalid();return JSON.parse(await read(this.start,this.end));}
  async *scanProperties():AsyncIterable<readonly [number,number,number,number]>{if(await this.kind()!=='object')throw invalid();const c=new Cursor(this.start+1);await c.space();if(await c.byte()===125)return;while(c.pos<this.end){const keyStart=c.pos;await c.string();if(c.pos-keyStart>1538)throw invalid();const keyEnd=c.pos;await c.space();if(await c.byte()!==58)throw invalid();c.pos++;await c.space();const start=c.pos;await c.skip();index.scan(c.pos-keyStart);yield [keyStart,keyEnd,start,c.pos] as const;await c.space();const b=await c.byte();c.pos++;if(b===125)return;if(b!==44)throw invalid();await c.space();}}
  async *properties():AsyncIterable<readonly [string,TaskValue]>{
   if(await this.kind()!=='object')throw invalid();
   const slot=index.acquire(this.start);
   if(slot){try{
    if(!slot.complete){for await(const [ks,ke,vs,ve]of this.scanProperties()){if(!index.append(slot,ks,ke,vs,ve))break;}if(!slot.oversized)slot.complete=true;}
    if(slot.complete){for(let i=0;i<slot.count;i++){const [ks,ke,vs,ve]=index.offsets(slot,i);const key=JSON.parse(await read(ks,ke));source.check();yield [key,new Value(vs,ve)] as const;source.check();}return;}
   }finally{index.release(slot);}}
   for await(const [ks,ke,vs,ve]of this.scanProperties())yield [JSON.parse(await read(ks,ke)),new Value(vs,ve)] as const;
  }
  async *elements():AsyncIterable<TaskValue>{if(await this.kind()!=='array')throw invalid();const c=new Cursor(this.start+1);await c.space();if(await c.byte()===93)return;while(c.pos<this.end){const start=c.pos;await c.skip();yield new Value(start,c.pos);await c.space();const b=await c.byte();c.pos++;if(b===93)return;if(b!==44)throw invalid();await c.space();}}
 }
 try{const c=new Cursor(0);await c.space();const start=c.pos;await c.skip();const end=c.pos;await c.space();if(c.pos!==size)throw invalid();return {value:new Value(start,end),close:source.close,stats:source.stats};}catch(e){await source.close();throw e;}
}
