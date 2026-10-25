import {artifactSpec,validateReceipt,DOCX_MAX_BYTES,type ArtifactReceipt} from './artifact.js';
import type {OutputFormat} from './output-format.js';
import {randomBytes,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import type {TaskResponse} from './processing.js';
import {taskError} from './quota.js';
export interface Artifact extends Omit<ArtifactReceipt,'byteLength'> {bytes:number;completeness:string;outputFormat?:OutputFormat;[key:string]:unknown}
/** One writer, awaited 64KiB writes; no event queue or whole-PDF buffer. */
export function taskWire(response:TaskResponse,taskId:string){
 const boundary='flowdoc-'+randomBytes(32).toString('base64url');let seq=0,started=false,pdfStarted=false,ended=false;
 const write=async(b:Uint8Array)=>{for(let at=0;at<b.length;at+=65536)await response.write(b.subarray(at,at+65536));};
 function start(){if(!started){response.start('multipart/mixed; boundary='+boundary+'; flowdoc=task-v1');started=true;}}
 async function event(type:string,status:string,detail:unknown,eventSeq:number|null=null){
  const b=Buffer.from(JSON.stringify({version:1,seq:++seq,type,taskId,at:new Date().toISOString(),status,eventSeq,detail}));
  if(b.length>32768||pdfStarted||ended)throw taskError('LIMIT_EXCEEDED');start();
  await write(Buffer.from('--'+boundary+'\r\nContent-Type: application/json\r\nContent-Length: '+b.length+'\r\n\r\n'));await write(b);await write(Buffer.from('\r\n'));
 }
 async function close(){await write(Buffer.from('--'+boundary+'--\r\n'));await response.end();ended=true;}
 async function artifact(path:string,meta:Artifact & {outputFormat:OutputFormat},signal:AbortSignal){
   const spec=artifactSpec(meta.outputFormat);validateReceipt(meta.outputFormat,{...meta,byteLength:meta.bytes,mediaType:meta.mediaType??spec.mediaType},meta.outputFormat==='docx'?DOCX_MAX_BYTES:256*1048576);
   // Validate the complete stored artifact and every delimiter overlap before PDF headers.
   const h=createHash('sha256'),marker=Buffer.from('--'+boundary);let size=0,tail=Buffer.alloc(0);
   for await(const b of createReadStream(path,{highWaterMark:65536,signal})){h.update(b);size+=b.length;const scan=Buffer.concat([tail,b]);if(scan.includes(marker))throw taskError('STORAGE_IO');tail=Buffer.from(scan.subarray(-marker.length+1));}
   if(size!==meta.bytes||h.digest('hex')!==meta.sha256)throw taskError('STORAGE_IO');
   await event('artifact','sending',{...meta,mediaType:spec.mediaType});pdfStarted=true;
   await write(Buffer.from('--'+boundary+'\r\nContent-Type: '+spec.mediaType+'\r\nContent-Disposition: attachment; filename="'+spec.filename+'"\r\nContent-Length: '+size+'\r\nX-FlowDoc-SHA256: '+meta.sha256+'\r\n\r\n'));
   const sentHash=createHash('sha256');let sent=0;
   for await(const b of createReadStream(path,{highWaterMark:65536,signal})){sent+=b.length;sentHash.update(b);await write(b);}
   if(sent!==size||sentHash.digest('hex')!==meta.sha256)throw taskError('STORAGE_IO');
   await write(Buffer.from('\r\n'));await close();
 }
 return {artifact,event,get started(){return started;},get pdfStarted(){return pdfStarted;},get ended(){return ended;},
  async error(code:string,stage:string,status:string){if(ended)return;if(pdfStarted){await response.abort();return;}await event('error',status,{code,stage,message:'Document task could not complete'});await close();},
  pdf(path:string,meta:Artifact,signal:AbortSignal){return artifact(path,{...meta,outputFormat:'pdf'},signal);}
 };
}
export type TaskWire=ReturnType<typeof taskWire>;
