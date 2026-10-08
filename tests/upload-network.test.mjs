import {beforeAll,afterAll,it,expect} from 'vitest';
import {request} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {createUploads} from '../dist/uploads/service.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {readUploadConfig} from '../dist/uploads/config.js';
const db=isolatedDatabase();let app,base,u;
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);u=createUploads({pool:db.pool,files:await createResourceFiles(await mkdtemp(join(tmpdir(),'network-'))),config:readUploadConfig({UPLOAD_STREAMS:'1',UPLOAD_REQUEST_IDLE_MS:'250',UPLOAD_REQUEST_MS:'900'})});app=createServer({pool:db.pool,isReady:()=>true,outputs:{},uploads:u});base=await app.listen({host:'127.0.0.1',port:0});});
afterAll(async()=>{await u.stop();await app.close();await db.close();});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function session(size=100){const r=await fetch(base+'/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:randomUUID(),items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:size}]})});expect(r.status).toBe(201);return (await r.json()).value;}
const path=s=>base+'/uploads/'+s.uploadId+'/items/'+s.items[0].resourceId+'/content';
function sending(s){let req;const result=new Promise(resolve=>{req=request(path(s),{method:'PUT',headers:{'content-type':'application/octet-stream'}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,retry:res.headers['retry-after']}));});req.on('error',()=>resolve({disconnected:true}));req.setTimeout(3000,()=>req.destroy());});req.flushHeaders();return {req,result};}
async function waitIdle(){for(let n=0;n<100;n++){if(!u.activeCount)return;await delay(10);}throw Error('Receiver did not release');}
async function retry(s){await waitIdle();const r=await fetch(path(s),{method:'PUT',headers:{'content-type':'application/octet-stream'},body:Buffer.alloc(s.items[0].expectedBytes)});expect(r.status).toBe(200);await r.arrayBuffer();}
it('polls receiving state, rejects excess streams, and retries a disconnected request',async()=>{
 const s=await session(),a=sending(s);a.req.write('a');
 let state;for(let n=0;n<50;n++){state=(await (await fetch(base+'/uploads/'+s.uploadId)).json()).value;if(state.items[0].status==='receiving')break;await delay(10);}
 expect(state.items[0].status).toBe('receiving');expect(state.received).toBe(0);
 const other=await session(),b=sending(other);b.req.end('x');expect(await b.result).toMatchObject({status:429,retry:'2'});
 a.req.destroy();await a.result;await retry(s);
});
it('idle timeout releases reception and permits retry',async()=>{const s=await session(),a=sending(s);a.req.write('a');const result=await a.result;expect(result.status===200).toBe(false);await retry(s);});
it('absolute timeout stops an otherwise active slow sender',async()=>{
 const s=await session(),a=sending(s),start=Date.now();a.req.write('a');const timer=setInterval(()=>a.req.write('b'),60);
 try{const result=await a.result;expect(result.status===200).toBe(false);expect(Date.now()-start).toBeLessThan(2500);}finally{clearInterval(timer);a.req.destroy();}await retry(s);
});
it('rejects short and oversized chunked bodies without publishing a receipt',async()=>{
 for(const body of ['ab','abcd']){const s=await session(3),a=sending(s);a.req.end(body);const result=await a.result;expect(result.status===200).toBe(false);await waitIdle();expect((await u.get(s.uploadId)).received).toBe(0);await retry(s);}
});
