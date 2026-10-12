import {describe,it,expect} from 'vitest';
import {createServer,request} from 'node:http';
import {createClient,bindImages,describeFailure} from '../examples/api-client/client.mjs';
import {createLocalServer} from '../examples/api-client/serve.mjs';

const schema={type:'object',fields:{photo:{type:'image'},caption:{type:'string'},groups:{type:'array',items:{type:'object',fields:{members:{type:'array',items:{type:'object',fields:{photo:{type:'image'}}}}}}},details:{type:'area',areaId:'a'}}};
const contract={version:2,globalSchema:schema,sections:{body:{inputSchema:schema,header:schema,footer:schema,formats:{entry:{inputSchema:schema}}}},areaFormats:{f:{ownerAreaId:'a',key:'picture',inputSchema:schema}}};
describe('local API client',()=>{
 it('maps image fields through scopes, two arrays and Area without rewriting text or source',()=>{
  const data={photo:'pic',caption:'pic',groups:[{members:[{photo:'pic'}]}],details:[{format:'picture',data:{photo:'pic'}}]};
  const input={docKey:'demo',data,sections:{body:{data,header:data,footer:data,content:[{format:'entry',data}]}}};
  const mapped=bindImages(input,contract,new Map([['pic','resource']]));
  expect(mapped.data.photo).toBe('resource');expect(mapped.data.caption).toBe('pic');
  expect(mapped.data.groups[0].members[0].photo).toBe('resource');
  expect(mapped.data.details[0].data.photo).toBe('resource');
  for(const scope of ['data','header','footer'])expect(mapped.sections.body[scope].photo).toBe('resource');
  expect(mapped.sections.body.content[0].data.photo).toBe('resource');expect(input.data.photo).toBe('pic');
 });
 it('uploads serially, finalizes, pins contract version and only prepares until explicitly submitted',async()=>{
  const calls=[];let active=0,max=0;
  const fetcher=async(path,opts={})=>{calls.push([path,opts]);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;
   const value=path.includes('/contract')?contract:path==='/api/uploads'?{uploadId:'u',items:[{key:'pic',resourceId:'r1'},{key:'second',resourceId:'r2'}]}:{};
   return Response.json({ok:true,value,warnings:[]});};
  const c=createClient({fetcher});const result=await c.prepare({docKey:'demo',data:{photo:'pic'}},[{key:'pic',file:new Blob(['one'],{type:'image/png'})},{key:'second',file:new Blob(['two'],{type:'image/png'})}]);
  expect(result.request.version).toBe(2);expect(result.request.data.photo).toBe('r1');expect(result.request.uploadId).toBe('u');
  expect(calls.map(c=>c[0])).toEqual(['/api/templates/demo/contract','/api/uploads','/api/uploads/u/items/r1/content','/api/uploads/u/items/r2/content','/api/uploads/u/finalize']);expect(max).toBe(1);
 });
 it('does not retry ambiguous POST, surfaces status/code/path, and supports resuming GET monitoring',async()=>{
  let count=0;const c=createClient({fetcher:async()=>{count++;throw Error('offline');}});
  await expect(c.submit({})).rejects.toMatchObject({code:'CONNECTION_LOST',ambiguous:true});expect(count).toBe(1);
  const failed=createClient({fetcher:async()=>Response.json({ok:false,issues:[{code:'QUEUE_FULL',path:'job',message:'Queue full'}]},{status:503})});
  await expect(failed.submit({})).rejects.toMatchObject({status:503,code:'QUEUE_FULL'});
  expect(describeFailure({code:'UPLOAD_GONE'})).toContain('อัปโหลด');expect(describeFailure({code:'OUTPUT_GONE'})).toContain('ไฟล์');
  const terminal={jobId:'id',status:'failed',errors:[{code:'PROCESS_INTERRUPTED'}]};
  const monitor=createClient({fetcher:async()=>Response.json({ok:true,value:terminal})});expect(await monitor.watch('id')).toEqual(terminal);
 });
 it('validates duplicate upload keys before creating a session',async()=>{
  let calls=0;const c=createClient({fetcher:async()=>{calls++;return Response.json({ok:true,value:contract});}});
  await expect(c.prepare({docKey:'x'},[{key:'same',file:new Blob(['x'])},{key:'same',file:new Blob(['x'])}])).rejects.toThrow();expect(calls).toBe(0);
 });
 it('preserves validation locations, expired uploads and consumed output errors without resubmitting',async()=>{
  for(const [status,code,path] of [[422,'MISSING_REQUIRED','data.name'],[410,'UPLOAD_GONE','uploadId'],[410,'OUTPUT_GONE','job']]){
   let calls=0;const c=createClient({fetcher:async()=>{calls++;return Response.json({ok:false,issues:[{code,path,message:'test'}]},{status});}});
   await expect(code==='OUTPUT_GONE'?c.download('id'):c.submit({})).rejects.toMatchObject({status,code,details:{issues:[{code,path,message:'test'}]}});expect(calls).toBe(1);
  }
 });
 it('treats helper connection failure as ambiguous POST and never resubmits while polling',async()=>{
  const c=createClient({fetcher:async()=>Response.json({ok:false,issues:[{code:'CONNECTION_LOST'}]},{status:502})});
  await expect(c.submit({})).rejects.toMatchObject({ambiguous:true});
  const methods=[],stages=[];let n=0;
  const poll=createClient({pollMs:1,fetcher:async(_,opts)=>{methods.push(opts.method);return Response.json({ok:true,value:{status:++n===1?'queued':'succeeded',outputAvailable:true}});}});
  await poll.watch('id',j=>stages.push(j.status));expect(methods).toEqual(['GET','GET']);expect(stages).toEqual(['queued','succeeded']);
 });
});
describe('loopback-only helper',()=>{
 it('serves only explicit assets and API routes, blocks foreign origins/hosts and preserves streaming status',async()=>{
  const upstream=createServer((req,res)=>{res.writeHead(503,{'content-type':'application/json','retry-after':'2'});res.end(JSON.stringify({ok:false,issues:[{code:'QUEUE_FULL'}]}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const helper=createLocalServer('http://127.0.0.1:'+upstream.address().port);await new Promise(r=>helper.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+helper.address().port;
  try{
   expect((await fetch(base)).status).toBe(200);expect((await fetch(base+'/../../package.json')).status).toBe(404);
   expect((await fetch(base+'/api/jobs',{method:'POST',headers:{origin:'https://foreign.invalid'},body:'{}'})).status).toBe(403);
   const foreign=await new Promise((resolve,reject)=>{const req=request(base+'/api/jobs',{headers:{host:'foreign.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});expect(foreign).toBe(403);
   expect((await fetch(base+'/api/arbitrary')).status).toBe(404);
   const r=await fetch(base+'/api/jobs',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'});expect(r.status).toBe(503);expect(r.headers.get('retry-after')).toBe('2');
   expect((await r.json()).issues[0].code).toBe('QUEUE_FULL');
  }finally{helper.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>helper.close(r)),new Promise(r=>upstream.close(r))]);}
  expect(()=>createLocalServer('https://example.com')).toThrow();
 });
});
