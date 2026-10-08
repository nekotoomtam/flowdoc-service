import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
const api=await import('../dist/http/server.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;let app;
const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);expect((await registerTemplate(pool,readFileSync('examples/srs-template.json','utf8'))).ok).toBe(true);});afterAll(async()=>{await app?.close();await db.close();});
it('projects contracts, accepts jobs and returns bounded safe HTTP failures',async()=>{
 expect(api.createServer).toBeTypeOf('function');app=api.createServer({pool,isReady:()=>true,outputs:{available:async()=>false},bodyLimit:4096});
 expect((await app.inject('/health')).statusCode).toBe(200);
 const contract=await app.inject('/templates/srs-table-trial/contract?version=1');expect(contract.statusCode).toBe(200);expect(contract.json().value).not.toHaveProperty('book');expect(JSON.stringify(contract.json())).not.toContain('rootIds');
 expect((await app.inject('/templates/srs-table-trial/contract?version=no')).statusCode).toBe(400);
 expect((await app.inject('/templates/missing/contract')).statusCode).toBe(404);
 const r=await app.inject({method:'POST',url:'/jobs',payload:input});expect(r.statusCode).toBe(202);const id=r.json().value.jobId;
 expect((await app.inject('/jobs/'+id)).json().value).toMatchObject({status:'queued',version:1});expect((await app.inject('/jobs/'+id+'/pdf')).statusCode).toBe(409);
 expect((await app.inject('/jobs/bad')).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/jobs',payload:{...input,data:{projectName:42}}})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:'/jobs',headers:{'content-type':'application/json'},payload:'{bad'})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:'/jobs',payload:{text:'x'.repeat(5000)}})).statusCode).toBe(413);
});
it('rejects admission when processor is unavailable and sanitizes storage errors',async()=>{
 expect(api.createServer).toBeTypeOf('function');const unavailable=api.createServer({pool,outputs:{},isReady:()=>false});
 const before=(await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
 expect((await unavailable.inject({method:'POST',url:'/jobs',payload:input})).statusCode).toBe(503);expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(before);await unavailable.close();
 const broken=api.createServer({pool:{query:async()=>{throw Error('/private/path password child stderr');}},outputs:{},isReady:()=>true});const r=await broken.inject('/jobs/00000000-0000-4000-8000-000000000000');expect(r.statusCode).toBe(503);expect(r.body).not.toMatch(/private|password|stderr|stack/i);await broken.close();
});
it('shutdown interrupts active downloads and waits for lease finalization',async()=>{
 const {Readable}=await import('node:stream');let finalized=false;
 const server=api.createServer({pool:{query:async()=>({rows:[{id:'00000000-0000-4000-8000-000000000000',version:1,status:'succeeded',warnings_json:[],skipped_indices:[],errors_json:[]} ]})},isReady:()=>true,outputs:{acquire:async()=>({stream:new Readable({read(){this.push(Buffer.alloc(1024));}}),finish:async success=>{expect(success).toBe(false);await new Promise(r=>setTimeout(r,20));finalized=true;}})}});
 const base=await server.listen({host:'127.0.0.1',port:0});const controller=new AbortController();const response=await fetch(base+'/jobs/00000000-0000-4000-8000-000000000000/pdf',{signal:controller.signal});expect(response.status).toBe(200);await server.close();controller.abort();expect(finalized).toBe(true);
});
