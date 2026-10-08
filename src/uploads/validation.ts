import {OperationError} from '../errors.js';
import type {UploadConfig} from './config.js';
export type UploadItem={key:string;source:'upload';mediaType:'image/jpeg'|'image/png';byteSize:number}|{key:string;source:'url';url:string};
export interface UploadManifest {requestKey:string;items:UploadItem[]}
const fail=(path:string)=>{throw new OperationError('INVALID_UPLOAD',path,'Invalid upload data');};
function object(value:unknown,path:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail(path);return value as Record<string,unknown>;}
function keys(value:Record<string,unknown>,allowed:string[],path:string){if(Object.keys(value).some(k=>!allowed.includes(k)))fail(path);}
export function validateManifest(input:unknown,config:UploadConfig):UploadManifest {
 const v=object(input,'upload');keys(v,['requestKey','items'],'upload');
 if(typeof v.requestKey!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(v.requestKey))fail('requestKey');
 if(!Array.isArray(v.items)||v.items.length<1||v.items.length>config.maxItems)fail('items');
 const seen=new Set<string>();let total=0;
 const items=(v.items as unknown[]).map((value,index):UploadItem=>{
  const path='items.'+index,i=object(value,path);
  if(typeof i.key!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(i.key)||seen.has(i.key))fail(path+'.key');
  const key=i.key as string;seen.add(key);
  if(i.source==='url'){
   keys(i,['key','source','url'],path);if(typeof i.url!=='string'||i.url.length>4096)fail(path+'.url');
   try{const u=new URL(i.url as string);if(u.protocol!=='https:'||u.username||u.password||u.hash)fail(path+'.url');}catch{fail(path+'.url');}
   return {key,source:'url',url:i.url as string};
  }
  keys(i,['key','source','mediaType','byteSize'],path);
  if(i.source!=='upload'||!['image/jpeg','image/png'].includes(String(i.mediaType)))fail(path+'.source');
  if(!Number.isSafeInteger(i.byteSize)||Number(i.byteSize)<1||Number(i.byteSize)>config.fileBytes)fail(path+'.byteSize');
  total+=Number(i.byteSize);if(total>config.setBytes)fail('items');
  return {key,source:'upload',mediaType:i.mediaType as 'image/jpeg'|'image/png',byteSize:Number(i.byteSize)};
 });
 return {requestKey:v.requestKey as string,items};
}
export function decodeBase64(value:unknown,max:number):Buffer {
 if(typeof value!=='string'||value.length>4*Math.ceil(max/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return fail('data');
 const bytes=Buffer.from(value,'base64');
 if(!bytes.length||bytes.length>max||bytes.toString('base64')!==value)return fail('data');return bytes;
}
