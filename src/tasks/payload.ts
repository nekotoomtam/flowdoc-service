import {createReadStream} from 'node:fs';import {Writable,Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import Parser from 'stream-json/Parser.js';
import type {TaskPolicy} from './policy.js';import {taskError} from './quota.js';
import {normalizeOutputName} from '@flowdoc/core';
/** Transport syntax/attribution only. Core owns typed data/image normalization in Stage 2. */
export async function inspectPayload(path:string,p:TaskPolicy,signal:AbortSignal){
 type Frame={kind:string;keys:Set<string>;key:string;index:number;path:string[];bytes:number};
 const stack:Frame[]=[],meta:Record<string,string>={};let key='',scalar='',scalarBytes=0,keyMode=false,capture=false,scalarPath:string[]=[],retained=0,root=false;
 const nextPath=()=>{const f=stack.at(-1);return f?[...f.path,f.kind==='startArray'?String(f.index++):f.key]:[];};
 const accept=(name:string,value?:string)=>{
  if(name==='startKey'){keyMode=true;key='';return;}
  if(name==='stringChunk'){
   if(keyMode){key+=value??'';if(Buffer.byteLength(key)>p.keyBytes)throw taskError('LIMIT_EXCEEDED');}
   else{scalarBytes+=Buffer.byteLength(value??'');if(capture&&scalarPath.length===1&&scalarPath[0]==='fileName'&&scalarBytes>240)throw taskError('INVALID_REQUEST');if(scalarBytes>p.stringBytes)throw taskError('LIMIT_EXCEEDED');if(capture)scalar+=value??'';}return;
  }
  if(name==='endKey'){
   keyMode=false;const f=stack.at(-1)!;if(f.keys.has(key))throw taskError('INVALID_REQUEST','Duplicate JSON property');
   f.keys.add(key);f.key=key;const b=Buffer.byteLength(key)+64;f.bytes+=b;retained+=b;if(retained>p.maxIndexBytes)throw taskError('LIMIT_EXCEEDED');
   if(f.path.length===0&&!['data','sections','meta','fileName'].includes(key))throw taskError(key==='taskId'?'TASK_REQUEST_CONFLICT':'INVALID_REQUEST');
   if(f.path.length===1&&f.path[0]==='meta'&&!['actorRef','reference'].includes(key))throw taskError('INVALID_REQUEST');return;
  }
  if(name==='startObject'||name==='startArray'){
   const at=nextPath();if(!root){if(name!=='startObject')throw taskError('INVALID_REQUEST');root=true;}
   if(at[0]==='meta'&&(at.length>1||name!=='startObject'))throw taskError('INVALID_REQUEST');
   if(at[0]==='fileName')throw taskError('INVALID_REQUEST');
   stack.push({kind:name,keys:new Set(),key:'',index:0,path:at,bytes:0});if(stack.length>p.maxDepth)throw taskError('LIMIT_EXCEEDED');return;
  }
  if(name==='endObject'||name==='endArray'){retained-=stack.pop()!.bytes;return;}
  if(name==='startString'||name==='startNumber'){
   scalarPath=nextPath();const fileName=scalarPath.length===1&&scalarPath[0]==='fileName';if(!root||scalarPath.length===0||scalarPath.length===1&&!fileName)throw taskError('INVALID_REQUEST');
   capture=scalarPath[0]==='meta'||fileName;scalar='';scalarBytes=0;if(capture&&name!=='startString')throw taskError('INVALID_REQUEST');return;
  }
  if(name==='numberChunk'){scalarBytes+=(value??'').length;if(scalarBytes>128)throw taskError('LIMIT_EXCEEDED');scalar+=value??'';return;}
  if(name==='endNumber'){if(!Number.isFinite(Number(scalar)))throw taskError('INVALID_REQUEST');return;}
  if(name==='endString'&&capture){if(scalarPath.length===1){const n=normalizeOutputName(scalar);if(n===undefined)throw taskError('INVALID_REQUEST');meta.fileName=n;return;}if(!scalar.trim()||Buffer.byteLength(scalar)>200||/[\x00-\x1f\x7f]/.test(scalar))throw taskError('INVALID_REQUEST');meta[scalarPath[1]!]=scalar;return;}
  if(['nullValue','trueValue','falseValue'].includes(name)){const at=nextPath();if(at.length<=1||at[0]==='meta')throw taskError('INVALID_REQUEST');}
 };
 const utf8=new TextDecoder('utf-8',{fatal:true});
 const decode=new Transform({transform(chunk:Buffer,_e,done){try{done(null,utf8.decode(chunk,{stream:true}));}catch{done(taskError('INVALID_REQUEST'));}},flush(done){try{done(null,utf8.decode());}catch{done(taskError('INVALID_REQUEST'));}}});
 const consume=new Writable({objectMode:true,write(t:{name:string;value?:string},_e,done){try{accept(t.name,t.value);done();}catch(e){done(e as Error);}}});
 try{await pipeline(createReadStream(path,{highWaterMark:65536}),decode,new Parser({packValues:false,streamValues:true}),consume,{signal});}
 catch(e){if(signal.aborted)throw signal.reason;throw (e as any)?.code?.match?.(/^(INVALID_REQUEST|LIMIT_EXCEEDED|TASK_REQUEST_CONFLICT)$/)?e:taskError('INVALID_REQUEST','Invalid payload JSON');}
 if(!root)throw taskError('INVALID_REQUEST');return {actorRef:meta.actorRef??null,reference:meta.reference??null,...(Object.hasOwn(meta,'fileName')?{fileName:meta.fileName||null}:{})};
}
