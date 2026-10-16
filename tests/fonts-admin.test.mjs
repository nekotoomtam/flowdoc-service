import {it,expect} from 'vitest';
const api=await import('../dist/http/fonts-admin.js').catch(()=>({}));
it('requires a separate bounded administrator credential and disables missing configuration',()=>{expect(api.checkFontAdminAccess).toBeTypeOf('function');expect(()=>api.checkFontAdminAccess({token:'a'.repeat(32),principal:'admin'},'a'.repeat(32))).toThrow();expect(()=>api.checkFontAdminAccess({token:'short',principal:'admin'})).toThrow();});
import {beforeAll,afterAll} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createServer} from '../dist/http/server.js';
import {stageSet,mutation as m} from './fontLifecycleFixture.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,createHash} from 'node:crypto';
const db=isolatedDatabase(),pool=db.pool,admin='a'.repeat(40),author='u'.repeat(40);let root,app;
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'fonts-admin-'));app=createServer({pool,outputs:{},isReady:()=>true,fontAdmin:{token:admin,principal:'font-test-admin'},authoring:{token:author,principal:'writer'},fontStorageRoot:root});await app.ready();});
afterAll(async()=>{await app.close();await db.close();await rm(root,{recursive:true,force:true});});
const call=(method,url,payload,token=admin)=>app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});
it('rejects authoring and unknown credentials on every administrator route before mutation or body parsing',async()=>{
 const id=randomUUID(),routes=[['POST','/imports'],['POST','/families'],['POST','/releases'],['PUT',`/imports/${id}/files/f`],['POST',`/imports/${id}/inspect`],['PATCH',`/releases/${id}`],['DELETE',`/releases/${id}`],...['submit-review','withdraw-review','activate','retire','reactivation-review'].map(a=>['POST',`/releases/${id}/${a}`]),...['run','approve','previews'].map(a=>['POST',`/reviews/${id}/${a}`]),['PUT',`/families/${id}/default`],['GET',`/releases/${id}`],['GET',`/imports/${id}`],['GET',`/reviews/${id}`],['GET',`/reviews/${id}/artifacts/${'a'.repeat(64)}`]];
 for(const [method,path] of routes){expect((await call(method,'/admin/fonts'+path,undefined,author)).statusCode,path).toBe(403);expect((await call(method,'/admin/fonts'+path,undefined,'unknown')).statusCode,path).toBe(401);}
 expect((await pool.query('SELECT count(*) FROM font_audit_events')).rows[0].count).toBe('0');
 const disabled=createServer({pool,outputs:{},isReady:()=>true});try{expect((await disabled.inject({method:'POST',url:'/admin/fonts/families',payload:{}})).statusCode).toBe(404);}finally{await disabled.close();}
});
it('streams bounded import bytes and licenses; prevents body actor forgery and duplicate JSON keys',async()=>{
 const font=await readFile('node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf'),license=await readFile('node_modules/@flowdoc/core/assets/fonts/OFL.txt'),sha=b=>createHash('sha256').update(b).digest('hex');
 const input={requestId:'http-import',reason:'HTTP fixture',files:[{clientKey:'f',byteLength:font.length,sha256:sha(font)}],licenseFiles:[{clientKey:'l',byteLength:license.length,sha256:sha(license)}],sourceEvidence:[{clientKey:'f',provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00Z',metadataHash:'a'.repeat(64),fileHashBinding:sha(font),sourceWeight:400,licenseClientKeys:['l']}]};
 expect((await call('POST','/admin/fonts/imports',{...input,actor:'forged'})).statusCode).toBe(422);
 const created=await call('POST','/admin/fonts/imports',input);expect(created.statusCode,created.body).toBe(201);const id=created.json().value.id;
 for(const [key,b] of [['f',font],['l',license]]){const r=await app.inject({method:'PUT',url:`/admin/fonts/imports/${id}/files/${key}`,headers:{authorization:'Bearer '+admin,'content-type':'application/octet-stream'},payload:b});expect(r.statusCode,r.body).toBe(200);}
 const inspected=await call('POST',`/admin/fonts/imports/${id}/inspect`,m(0));expect(inspected.statusCode,inspected.body).toBe(200);
 const dup=await app.inject({method:'POST',url:'/admin/fonts/imports',headers:{authorization:'Bearer '+admin,'content-type':'application/json'},payload:'{"requestId":"a","requestId":"b"}'});expect(dup.statusCode).toBe(400);
 expect((await pool.query("SELECT DISTINCT actor FROM font_audit_events WHERE action LIKE 'import-%'")).rows).toEqual([{actor:'font-test-admin'}]);
},60000);
it('serves real admin review PDFs and safe lifecycle receipts across all six states',async()=>{
 const f=await stageSet(pool,root),base='/admin/fonts/releases/'+f.id;
 const request=async(method,url,body)=>{const r=await call(method,url,body);expect(r.statusCode,r.body).toBe(200);return r.json().value;};
 let q=await request('POST',base+'/submit-review',m(0,{manifestDigest:f.manifestDigest}));const preview=await request('POST',`/admin/fonts/reviews/${q.reviewId}/previews`,m(q.revision,{purpose:'font-review',reviewId:q.reviewId,manifestDigest:f.manifestDigest}));expect(preview.report.ok,JSON.stringify(preview)).toBe(true);
 const hash=preview.report.faces[0].artifactHash,pdf=await call('GET',`/admin/fonts/reviews/${q.reviewId}/artifacts/${hash}`);expect(pdf.headers['content-type']).toBe('application/pdf');expect(pdf.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
 const approved=await request('POST',`/admin/fonts/reviews/${q.reviewId}/approve`,m(preview.revision,{manifestDigest:f.manifestDigest,reportDigest:preview.reportDigest,artifactHashes:[hash]}));expect(approved.state).toBe('ready');
 const input=m(approved.revision,{reviewId:q.reviewId,manifestDigest:f.manifestDigest}),activated=await request('POST',base+'/activate',input);expect(await request('POST',base+'/activate',input)).toEqual(activated);
 const active=await request('GET',base);expect(active.state).toBe('active');expect(JSON.stringify(active)).not.toContain('storage_key');
 const retired=await request('POST',base+'/retire',m(activated.revision));expect(retired.state).toBe('retired');
 expect((await call('POST',base+'/activate',m(retired.revision,{reviewId:q.reviewId,manifestDigest:f.manifestDigest}))).statusCode).toBe(409);
},120000);
