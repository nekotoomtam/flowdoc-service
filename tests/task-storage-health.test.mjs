import {beforeAll,beforeEach,afterEach,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createTaskIntake} from '../dist/tasks/intake.js';
import {createServer} from '../dist/http/server.js';
const db=isolatedDatabase(),pool=db.pool,MiB=1048576,auth='Bearer '+'h'.repeat(40);
let intake,app,root,free,readFailure=false,runtimeReady=true;
const identity=h=>h===auth?{ownerKey:'owner',principalId:'client',taskRead:true,docKeys:['health-fixture']}:null;
const open=()=>intake.open({authorization:auth,docKey:'health-fixture',contentType:'multipart/form-data; boundary=health'});
const health=()=>app.inject('/health');
async function accounting(){return (await pool.query('SELECT * FROM task_resource_reservations ORDER BY task_id')).rows;}
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));t.docKey=t.templateId='health-fixture';expect((await registerTemplate(pool,JSON.stringify(t))).ok).toBe(true);});
beforeEach(async()=>{free=20_000_000_000;readFailure=false;runtimeReady=true;root=await mkdtemp(join(tmpdir(),'flowdoc-storage-health-'));intake=await createTaskIntake({pool,root,resolveCredential:identity,policy:{maxOwnerTasks:1},freeBytes:async()=>{if(readFailure)throw Error('private storage path');return free;}});app=createServer({pool,outputs:{},isReady:()=>runtimeReady&&intake.isReady(),tasks:{intake,processing:{}}});});
afterEach(async()=>{await app?.close();await intake?.stop();await rm(root,{recursive:true,force:true});});
afterAll(async()=>{await db.close();});
it('matches initial storage admission at the floor and recovers on the same app without reserving bytes',async()=>{
 const before=await accounting();free=256*MiB+8*MiB;
 expect((await health()).statusCode).toBe(200);
 free--;expect((await health()).statusCode).toBe(503);
 await expect(open()).rejects.toHaveProperty('code','STORAGE_CAPACITY');
 free=0;expect((await health()).statusCode).toBe(503);
 expect(await accounting()).toEqual(before);
 free=256*MiB+8*MiB;expect((await health()).statusCode).toBe(200);
 expect((await open()).taskId).toBeTruthy();
});
it('accounts for outstanding reservations while owned lookup remains available',async()=>{
 free=256*MiB+12*MiB;const task=await open(),before=await accounting();
 for(let i=0;i<3;i++)expect((await health()).statusCode).toBe(503);
 const lookup=await app.inject({method:'POST',url:'/documents',headers:{authorization:auth,'content-type':'application/json'},payload:{taskId:task.taskId}});
 expect(lookup.statusCode).toBe(200);expect(lookup.json().task.taskId).toBe(task.taskId);
 expect(await accounting()).toEqual(before);
 free=20_000_000_000;expect((await health()).statusCode).toBe(200);
});
it('fails closed on a space-reading error without leaking details and recovers',async()=>{
 readFailure=true;const r=await health();expect(r.statusCode).toBe(503);expect(r.body).not.toContain('private storage path');
 readFailure=false;expect((await health()).statusCode).toBe(200);
 runtimeReady=false;expect((await health()).statusCode).toBe(503);
});
it('does not treat a principal-specific quota as global storage unreadiness',async()=>{
 await open();await expect(open()).rejects.toHaveProperty('code','QUEUE_FULL');
 expect((await health()).statusCode).toBe(200);
});
