import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';
import {createWriteStream} from 'node:fs';
import {unlink} from 'node:fs/promises';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import ipaddr from 'ipaddr.js';

export function publicAddress(address:string):boolean {
 try{return ipaddr.parse(address).range()==='unicast';}catch{return false;}
}
type Resolver=(host:string)=>Promise<{address:string;family:number}[]>;
export async function resolveImageUrl(raw:string,resolver:Resolver=host=>lookup(host,{all:true,verbatim:true})){
 const url=new URL(raw),host=url.hostname.replace(/^\[|\]$/g,'');
 if(url.protocol!=='https:'||url.username||url.password||url.hash||raw.length>4096)throw Error('Unsupported image URL');
 const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host);
 if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw Error('Image destination blocked');
 return {url,address:addresses[0]!.address,family:addresses[0]!.family};
}
/** Downloads only to a caller-owned file, with a pinned public address per hop. */
export async function downloadImage(raw:string,path:string,signal?:AbortSignal,maxBytes=50*1048576,timeoutMs=30000):Promise<number>{
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>50*1048576)throw Error('Invalid download limits');
 const timed=AbortSignal.timeout(timeoutMs),abort=signal?AbortSignal.any([signal,timed]):timed;
 let current=raw,complete=false;
 try{
  for(let hop=0;hop<=3;hop++){
   abort.throwIfAborted();
   const destination=await new Promise<Awaited<ReturnType<typeof resolveImageUrl>>>((resolve,reject)=>{
    const stop=()=>reject(Error('Download cancelled'));abort.addEventListener('abort',stop,{once:true});
    resolveImageUrl(current).then(resolve,reject).finally(()=>abort.removeEventListener('abort',stop));
   });abort.throwIfAborted();
   const response=await new Promise<import('node:http').IncomingMessage>((resolve,reject)=>{
    const req=request(destination.url,{agent:false,signal:abort,headers:{accept:'image/jpeg, image/png','accept-encoding':'identity'},
     lookup:(_host,options,callback)=>{const entry={address:destination.address,family:destination.family};if(options.all)callback(null,[entry]);else callback(null,entry.address,entry.family);}},resolve);
    req.on('error',reject);req.end();
   });
   if([301,302,303,307,308].includes(response.statusCode??0)){
    const location=response.headers.location;response.destroy();if(!location||hop===3)throw Error('Image redirect limit');current=new URL(location,destination.url).href;continue;
   }
   if(response.statusCode!==200||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();throw Error('Image download rejected');}
   let bytes=0;
   await pipeline(response,new Transform({transform(chunk:Buffer,_e,done){bytes+=chunk.length;done(bytes>maxBytes?Error('Image download too large'):null,chunk);}}),createWriteStream(path,{flags:'wx',mode:0o600}),{signal:abort});
   if(!bytes)throw Error('Empty image');complete=true;return bytes;
  }
  throw Error('Image redirect limit');
 }finally{if(!complete)try{await unlink(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
}
