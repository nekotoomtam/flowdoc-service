// Test-only child. Parent kills only this process, then exercises actual persisted recovery.
import {Pool} from 'pg';import {Readable} from 'node:stream';
import {createTaskIntake} from '../dist/tasks/intake.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.env.TASK_TEST_SCHEMA});
const service=await createTaskIntake({pool,root:process.env.TASK_TEST_ROOT,freeBytes:async()=>20_000_000_000,resolveCredential:()=>({ownerKey:'customer-a',principalId:'api-a',docKeys:['srs-basic'],taskRead:true})});
const t=await service.open({authorization:'Bearer '+'a'.repeat(40),docKey:'srs-basic',contentType:'multipart/form-data; boundary=crash-test'});
if(process.env.TASK_TEST_OPEN_ONLY){process.send?.({taskId:t.taskId});setInterval(()=>{},1000);}else{
const source=new Readable({read(){}});
const pending=service.receive({taskId:t.taskId,authorization:'Bearer '+'a'.repeat(40),contentType:'multipart/form-data; boundary=crash-test',body:source});pending.catch(()=>{});
source.push(Buffer.from('--crash-test\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n{"data":{},"sections":[]}\r\n--crash-test\r\nContent-Disposition: form-data; name="/sections/0/assets/0/image"\r\nContent-Type: image/jpeg\r\n\r\n'));
source.push(Buffer.alloc(300000,1));
for(let n=0;n<100;n++){const r=await pool.query("SELECT count(*) FROM task_files WHERE task_id=$1 AND (state='received' OR stored_bytes>0)",[t.taskId]);if(Number(r.rows[0].count)===2){process.send?.({taskId:t.taskId});break;}await new Promise(r=>setTimeout(r,30));}
}
