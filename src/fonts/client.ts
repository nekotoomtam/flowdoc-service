import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {FONT_LIMITS} from './types.js';
import {UUID} from './files.js';
import {fontError} from './repository.js';
export function createFontAdminClient(config:{baseUrl:string;token:string;fetch?:typeof fetch}){
 const base=new URL(config.baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash||base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||!config.token||config.token.length<32)throw Error('Invalid font administrator configuration');
 async function call(path:string,method='GET',body?:unknown,binary=false){
  const r=await (config.fetch??fetch)(new URL('/admin/fonts'+path,base),{method,headers:{authorization:'Bearer '+config.token,...(body===undefined?{}:{'content-type':binary?'application/octet-stream':'application/json'})},...(body===undefined?{}:{body:binary?body as Buffer:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(path.endsWith('/run')?720000:30000)});
  const reader=r.body?.getReader(),parts:Uint8Array[]=[];let size=0;try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4194304){await reader.cancel();throw Error();}parts.push(value);}}finally{reader?.releaseLock();}
  const result=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!result||typeof result.ok!=='boolean'||result.ok&&!r.ok)throw Error();return result;
 }
 return {async execute(command:string,input:any){
  if(!input||typeof input!=='object'||Array.isArray(input))fontError('INVALID_FONT_INPUT');
  if(command==='import'){
   const {files,licenseFiles,...metadata}=input;if(!Array.isArray(files)||!files.length||files.length>FONT_LIMITS.files||!Array.isArray(licenseFiles)||licenseFiles.length>FONT_LIMITS.licenses)fontError('INVALID_FONT_INPUT');
   const data=new Map<string,Buffer>();let total=0;
   const declarations=async(entries:any[],max:number)=>{const output=[];for(const f of entries){if(!f||Object.keys(f).some(k=>!['clientKey','path'].includes(k))||typeof f.clientKey!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(f.clientKey)||data.has(f.clientKey)||typeof f.path!=='string')fontError('INVALID_FONT_INPUT');const info=await stat(f.path);if(!info.isFile()||info.size<1||info.size>max||total+info.size>FONT_LIMITS.setBytes)fontError('FONT_LIMIT_EXCEEDED');const bytes=await readFile(f.path);if(bytes.length!==info.size)fontError('FONT_UPLOAD_CONFLICT');total+=bytes.length;data.set(f.clientKey,bytes);output.push({clientKey:f.clientKey,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}return output;};
   const declaredFiles=await declarations(files,FONT_LIMITS.fileBytes),declaredLicenses=await declarations(licenseFiles,FONT_LIMITS.licenseBytes),created=await call('/imports','POST',{...metadata,files:declaredFiles,licenseFiles:declaredLicenses});if(!created.ok)return created;const current=await call('/imports/'+created.value.id);if(!current.ok)return current;if(current.value.state==='inspected')return created;
   for(const [key,bytes] of data){const uploaded=await call('/imports/'+created.value.id+'/files/'+key,'PUT',bytes,true);if(!uploaded.ok)return uploaded;}return created;
  }
  if(command==='family-create')return call('/families','POST',input);
  if(command==='release-stage')return call('/releases','POST',input);
  const {id,entity,...body}=input;if(typeof id!=='string'||!UUID.test(id))fontError('INVALID_FONT_INPUT');
  if(command==='show'){if(Object.keys(body).length||!['release','import','review'].includes(entity))fontError('INVALID_FONT_INPUT');return call('/'+({release:'releases',import:'imports',review:'reviews'} as any)[entity]+'/'+id);}
  if(entity!==undefined)fontError('INVALID_FONT_INPUT');
  if(command==='import-inspect')return call('/imports/'+id+'/inspect','POST',body);
  if(command==='release-edit')return call('/releases/'+id,'PATCH',body);
  if(command==='release-delete')return call('/releases/'+id,'DELETE',body);
  if(command==='default-set')return call('/families/'+id+'/default','PUT',body);
  if(command==='review-run'||command==='review-approve')return call('/reviews/'+id+'/'+(command==='review-run'?'run':'approve'),'POST',body);
  const action=({ 'review-submit':'submit-review','review-withdraw':'withdraw-review','activate':'activate','retire':'retire','reactivation-review':'reactivation-review'} as Record<string,string>)[command];if(!action)fontError('INVALID_FONT_INPUT');return call('/releases/'+id+'/'+action,'POST',body);
 }};
}
