import type {FastifyInstance} from 'fastify';
import {Readable} from 'node:stream';
import {failure,OperationError} from '../errors.js';
import type {Uploads} from '../uploads/service.js';
import {decodeBase64} from '../uploads/validation.js';
export async function registerUploads(app:FastifyInstance,uploads:Uploads){
 let receiving=0;
 const held=new WeakMap<object,NodeJS.Timeout>();
 const release=(req:any)=>{const timer=held.get(req);if(timer){clearTimeout(timer);held.delete(req);receiving--;req.raw.setTimeout?.(0);}};
 app.addHook('onRequest',async(req,reply)=>{
  const route=req.routeOptions.url??'';
  if(!route.endsWith('/content')&&!route.endsWith('/base64'))return;
  if(receiving>=uploads.config.streams)return reply.code(429).header('Retry-After','2').send(failure(new OperationError('UPLOAD_BUSY','upload','Upload streams busy')));
  receiving++;held.set(req,setTimeout(()=>req.raw.destroy(),uploads.config.requestMs));
  req.raw.setTimeout?.(uploads.config.requestIdleMs,()=>req.raw.destroy());
 });
 app.addHook('onResponse',async req=>release(req));
 app.addHook('onRequestAbort',async req=>release(req));
 app.addHook('onTimeout',async req=>release(req));
 const status:Record<string,number>={INVALID_UPLOAD:422,UPLOAD_NOT_FOUND:404,UPLOAD_GONE:410,UPLOAD_CONFLICT:409,UPLOAD_INCOMPLETE:409,BODY_TOO_LARGE:413,UPLOAD_BUSY:429,UPLOAD_CAPACITY:429};
 const run=async(reply:any,action:()=>Promise<unknown>,code=200)=>{
  try{return reply.code(code).send({ok:true,value:await action(),warnings:[]});}
  catch(e){const r=failure(e);const http=e instanceof OperationError?status[e.code]??503:503;if(http===429)reply.header('Retry-After','2');return reply.code(http).send(r);}
 };
 app.post('/uploads',async(req,reply)=>run(reply,()=>uploads.create(req.body),201));
 app.get<{Params:{id:string}}>('/uploads/:id',async(req,reply)=>run(reply,()=>uploads.get(req.params.id)));
 app.post<{Params:{id:string}}>('/uploads/:id/finalize',async(req,reply)=>run(reply,()=>uploads.finalize(req.params.id)));
 app.put<{Params:{id:string;item:string}}>('/uploads/:id/items/:item/base64',{bodyLimit:2097152},async(req,reply)=>run(reply,async()=>{
  const body=req.body as {data?:unknown};if(!body||typeof body!=='object'||Object.keys(body).some(k=>k!=='data'))throw new OperationError('INVALID_UPLOAD','data','Invalid Base64 request');
  const bytes=decodeBase64(body.data,uploads.config.base64Bytes);
  return uploads.receive(req.params.id,req.params.item,Readable.from([bytes]));
 }));
 await app.register(async binary=>{
  binary.addContentTypeParser(['application/octet-stream','image/jpeg','image/png'],(_req,payload,done)=>done(null,payload));
  binary.put<{Params:{id:string;item:string}}>('/uploads/:id/items/:item/content',async(req,reply)=>{
   const abort=new AbortController(),aborted=()=>abort.abort();req.raw.once('aborted',aborted);
   try{return await run(reply,async()=>{
    if(req.headers['content-encoding'])throw new OperationError('INVALID_UPLOAD','encoding','Content encoding unsupported');
    return uploads.receive(req.params.id,req.params.item,req.body as Readable,abort.signal);
   });}finally{req.raw.removeListener('aborted',aborted);}
  });
 });
}
