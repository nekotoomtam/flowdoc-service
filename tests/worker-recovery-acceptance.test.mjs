import {describe,beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';import {appendFileSync} from 'node:fs';
import {prepareP5Lab} from './helpers/worker-p5-lab.mjs';
import {template,body,contentType,artifact} from './taskDocxFixture.mjs';
describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('P5 native acceptance (FLOWDOC_WORKER_LAB=1)',()=>{
const stage=process.env.P5_RECOVERY_STAGE,root='/results/app/recovery-runtime',BASE='http://127.0.0.1:31841';let pool,service,spy;const launches=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const post=async()=>{const r=await fetch(BASE+'/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'doc-key':'docx-small','content-type':contentType,'output-format':'pdf',accept:'multipart/mixed'},body:await body(0,'Recovery ไทย EN')});return Buffer.from(await r.arrayBuffer());};
beforeAll(async()=>{
 await prepareP5Lab();await(await import('node:fs/promises')).mkdir(root,{recursive:true});
 Object.assign(process.env,{FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json',TASK_QUEUE_PROFILE:'1g-2cpu',TASK_CREDENTIALS_FILE:root+'/credentials.json',TASK_STORAGE_DIR:root+'/tasks',EXPORT_TEMP_DIR:root+'/temp',EXPORT_OUTPUT_DIR:root+'/outputs',UPLOAD_STAGING_DIR:root+'/staging',HOST:'127.0.0.1',PORT:'31841'});
 await writeFile(process.env.TASK_CREDENTIALS_FILE,JSON.stringify([{token:'t'.repeat(40),ownerKey:'lab',principalId:'lab',docKeys:['docx-small'],taskRead:true}]));
 pool=(await import('../dist/db/connection.js')).createPool(process.env.DATABASE_URL);expect((await(await import('../dist/db/migrate.js')).migrate(pool)).ok).toBe(true);
 if(stage==='1')expect((await(await import('../dist/templates/registry.js')).registerTemplate(pool,JSON.stringify(template()))).ok).toBe(true);
 {
  const mod=await import('../dist/workers/launcher.js'),original=mod.createWorkerLauncher;
  spy=vi.spyOn(mod,'createWorkerLauncher').mockImplementation(async(...args)=>{const launcher=await original(...args);return {...launcher,async spawnBlocked(spec){if(spec.kind==='task-render'){const running=(await pool.query("SELECT id,task_id FROM generation_jobs WHERE status='running'")).rows;expect(running).toHaveLength(1);const record={stage,jobId:running[0].id,taskId:running[0].task_id};launches.push(record);appendFileSync('/results/app/recovery-launches.jsonl',JSON.stringify(record)+'\n');}const h=await launcher.spawnBlocked(spec);if(spec.kind!=='task-render'||stage!=='1')return h;return {...h,async start(){await h.start();process.kill(h.identity.pid,'SIGSTOP');await writeFile('/results/app/recovery-worker.json',JSON.stringify(h.identity));}};}};});
 }
 service=await(await import('../dist/server.js')).startService();const end=Date.now()+10000;while((await fetch(BASE+'/health')).status!==200){if(Date.now()>end)throw Error('recovery Service not ready');await wait(25);}
},45000);
afterAll(async()=>{await service?.stop();spy?.mockRestore();await pool?.end();});
it('recovers an actually interrupted HTTP task without resend and reconciles its DB reservations',async()=>{
 if(stage==='1'){
  void post().catch(()=>{});const end=Date.now()+15000;let row;
  while(true){row=(await pool.query("SELECT * FROM tasks WHERE status='processing' AND child_pid IS NOT NULL")).rows[0];if(row){try{await readFile('/results/app/recovery-worker.json');break;}catch{}}if(Date.now()>end)throw Error('task did not reach paused placed renderer');await wait(20);}
  const reservations=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[row.id])).rows;expect(reservations[0].queue_slot_held).toBe(true);await writeFile('/results/app/recovery-before.json',JSON.stringify({row,reservations}));
  await writeFile('/results/app/host-request.json',JSON.stringify({token:'crash-coordinator-p5',action:'crash-coordinator'}));await new Promise(()=>{});
 }else{
  const before=JSON.parse(await readFile('/results/app/recovery-before.json','utf8'));let row,reservation;const end=Date.now()+10000;
  do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[before.row.id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[before.row.id])).rows[0];if(row.status==='failed'&&!reservation.queue_slot_held&&Number(reservation.storage_held_bytes)===Number(reservation.storage_used_bytes))break;await wait(25);}while(Date.now()<end);
  expect(row.status).toBe('failed');expect(row.terminal_reason).toBe('WORKER_INTERRUPTED');expect(reservation.queue_slot_held).toBe(false);expect(Number(reservation.storage_held_bytes)).toBe(Number(reservation.storage_used_bytes));expect(Number(reservation.storage_used_bytes)).toBeGreaterThan(0);expect(row.child_pid).toBeNull();expect(row.writer_pid).toBeNull();
  const jobs=(await pool.query('SELECT * FROM generation_jobs WHERE task_id=$1',[row.id])).rows;expect(jobs).toHaveLength(1);expect(jobs[0].status).toBe('failed');
  await wait(500);expect(launches).toHaveLength(0);const fresh=artifact([await post()]);expect(fresh.bytes.subarray(0,5).toString()).toBe('%PDF-');expect(launches).toHaveLength(1);expect(launches[0].taskId).not.toBe(row.id);const trace=(await readFile('/results/app/recovery-launches.jsonl','utf8')).trim().split('\n').map(JSON.parse);expect(trace.filter(r=>r.taskId===row.id)).toHaveLength(1);await writeFile('/results/app/recovery-fresh.pdf',fresh.bytes);await writeFile('/results/app/recovery-after.json',JSON.stringify({row,reservation,jobs,freshBytes:fresh.bytes.length,retainedPayloadBytes:Number(reservation.storage_used_bytes),noAutomaticResendObservedMs:500,launchTrace:trace}));
 }
},30000);
});
