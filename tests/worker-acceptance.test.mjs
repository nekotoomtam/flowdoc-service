import {describe,beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {prepareP5Lab} from './helpers/worker-p5-lab.mjs';
import {fixture} from './helpers/model20-db.mjs';
import {template,body,contentType,artifact} from './taskDocxFixture.mjs';
describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('P5 native acceptance (FLOWDOC_WORKER_LAB=1)',()=>{
let pool,service,root,spy,intakeSpy,intake;const BASE='http://127.0.0.1:31841',events=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function request(path,options={}){const r=await fetch(BASE+path,options);return {status:r.status,headers:Object.fromEntries(r.headers),bytes:Buffer.from(await r.arrayBuffer())};}
beforeAll(async()=>{
 await prepareP5Lab();root=await mkdtemp('/results/app/p5-http-');
 Object.assign(process.env,{FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json',TASK_QUEUE_PROFILE:'1g-2cpu',TASK_CREDENTIALS_FILE:root+'/credentials.json',TASK_STORAGE_DIR:root+'/tasks',EXPORT_TEMP_DIR:root+'/temp',EXPORT_OUTPUT_DIR:root+'/outputs',UPLOAD_STAGING_DIR:root+'/staging',FONT_ADMIN_TOKEN:'a'.repeat(40),FONT_ADMIN_PRINCIPAL:'font-test-admin',FONT_STORAGE_DIR:root+'/fonts',HOST:'127.0.0.1',PORT:'31841'});
 await writeFile(process.env.TASK_CREDENTIALS_FILE,JSON.stringify([{token:'t'.repeat(40),ownerKey:'lab',principalId:'lab',docKeys:['docx-small'],taskRead:true}]));
 pool=(await import('../dist/db/connection.js')).createPool(process.env.DATABASE_URL);expect((await(await import('../dist/db/migrate.js')).migrate(pool)).ok).toBe(true);
 for(const m of [18,19]){const {t}=fixture(m,'p5-model'+m);expect((await(await import('../dist/templates/registry.js')).registerTemplate(pool,JSON.stringify(t))).ok).toBe(true);}
 expect((await(await import('../dist/templates/registry.js')).registerTemplate(pool,JSON.stringify(template()))).ok).toBe(true);
 const mod=await import('../dist/workers/launcher.js'),original=mod.createWorkerLauncher;
 spy=vi.spyOn(mod,'createWorkerLauncher').mockImplementation((c,d={})=>original(c,{...d,onGateEvent:e=>{events.push(e);appendFileSync('/results/app/http-gate-events.jsonl',JSON.stringify(e)+'\n');}}));
 const intakeModule=await import('../dist/tasks/intake.js'),originalIntake=intakeModule.createTaskIntake;intakeSpy=vi.spyOn(intakeModule,'createTaskIntake').mockImplementation(async(...args)=>{intake=await originalIntake(...args);return intake;});
 service=await(await import('../dist/server.js')).startService();
 const end=Date.now()+10000;while((await request('/health')).status!==200){if(Date.now()>end)throw Error('Service not ready');await wait(50);}
},45000);
afterAll(async()=>{await service?.stop();spy?.mockRestore();intakeSpy?.mockRestore();await pool?.end();});
it('serves actual legacy model18/19 PDF requests with font preflight and valid artifacts',async()=>{
 const receipts=[];
 for(const model of [18,19]){
  const input=fixture(model,'p5-model'+model).request;
  const submitted=await request('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});expect(submitted.status,submitted.bytes.toString()).toBe(202);
  const job=JSON.parse(submitted.bytes).value.jobId;let state;const end=Date.now()+20000;
  do{state=JSON.parse((await request('/jobs/'+job)).bytes).value;if(state.status==='failed')throw Error(JSON.stringify(state));if(Date.now()>end)throw Error('legacy timeout');if(state.status!=='succeeded')await wait(25);}while(state.status!=='succeeded');
  const pdf=await request('/jobs/'+job+'/pdf');expect(pdf.status).toBe(200);expect(pdf.bytes.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.bytes.length).toBeGreaterThan(1000);expect(pdf.bytes.toString('latin1')).toContain('%%EOF');await writeFile('/results/app/legacy-model'+model+'.pdf',pdf.bytes);receipts.push({model,jobId:job,bytes:pdf.bytes.length,sha256:hash(pdf.bytes)});
 }
 await writeFile('/results/app/legacy-http.json',JSON.stringify(receipts));
},60000);
it('streams actual task PDF and DOCX with JPEG/PNG preparation and stores final delivery evidence',async()=>{
 const receipts=[];
 for(const format of ['pdf','docx']){
  const result=await request('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':'docx-small','output-format':format,accept:'multipart/mixed'},body:await body(2,'P5 ไทย EN content')});
  expect(result.status,result.bytes.toString()).toBe(200);const file=artifact([result.bytes]);expect(file.bytes.length).toBeGreaterThan(1000);expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');
  await writeFile('/results/app/task-with-images.'+format,file.bytes);await writeFile('/results/app/task-'+format+'-wire.bin',result.bytes);receipts.push({format,bytes:file.bytes.length,sha256:hash(file.bytes),headers:file.headers});
 }
 // Transport finish precedes the final DB transaction; observe both independently.
 let rows,reservations;const end=Date.now()+5000;const trace=[];
 do{rows=(await pool.query('SELECT * FROM tasks ORDER BY created_at')).rows;reservations=(await pool.query('SELECT queue_slot_held FROM task_resource_reservations')).rows;trace.push({statuses:rows.map(r=>r.status),slots:reservations.map(r=>r.queue_slot_held)});if(rows.length===2&&rows.every(r=>r.status==='succeeded')&&reservations.length===2&&reservations.every(r=>r.queue_slot_held===false))break;await wait(20);}while(Date.now()<end);
 await writeFile('/results/app/task-finalization-trace.json',JSON.stringify({trace,rows,reservations}));expect(rows).toHaveLength(2);expect(rows.every(r=>r.status==='succeeded'),JSON.stringify(rows)).toBe(true);expect(reservations).toHaveLength(2);expect(reservations.every(r=>r.queue_slot_held===false)).toBe(true);
 await writeFile('/results/app/task-http.json',JSON.stringify({receipts,rows}));
},60000);
it('uses native font inspection and serves a real admin specimen over HTTP',async()=>{
 const {createFontLibrary}=await import('../dist/fonts/service.js'),{createFontInspector}=await import('../dist/fonts/inspection.js');
 // Reuse the Service-owned inspector through the existing library composition seam.
 expect(events.some(e=>e.event==='exec')).toBe(true);
 // Build the font fixture using the same launcher instance, never a default direct spawn.
 const launcher=await spy.mock.results[0].value;
 const inspect=createFontInspector(launcher),fontPath='/candidate/node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf',metadata=await inspect(fontPath),font=await readFile(fontPath),license=await readFile('/candidate/node_modules/@flowdoc/core/assets/fonts/OFL.txt');
 const lib=await createFontLibrary({pool,root:root+'/fonts',principal:'font-test-admin',inspect}),family=await lib.createFamily({requestId:randomUUID(),reason:'P5 fixture',displayName:'P5 family',internalNames:[metadata.names.family],sourceIdentity:{provider:'google-fonts',providerFamilyKey:randomUUID()}});
 const imp=await lib.createImport({requestId:randomUUID(),reason:'P5 fixture',files:[{clientKey:'font',byteLength:font.length,sha256:hash(font)}],licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:hash(license)}],sourceEvidence:[{clientKey:'font',provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'b'.repeat(64),fileHashBinding:hash(font),sourceWeight:400,licenseClientKeys:['license']}]});
 const mutation=(revision,extra={})=>({requestId:randomUUID(),reason:'P5 verification',expectedRevision:revision,...extra});
 try{
  await lib.receive(imp.id,'font',(async function*(){yield font;})());await lib.receive(imp.id,'license',(async function*(){yield license;})());const checked=await lib.inspectImport(imp.id,mutation(0)),entry=checked.files.find(f=>f.clientKey==='font');const f=await lib.stageRelease({requestId:randomUUID(),reason:'P5 fixture',familyId:family.id,version:1,importId:imp.id,languageScope:['th','en'],faceBindings:[{assetId:entry.assetId,sourceEvidenceId:entry.sourceEvidenceId,sourceWeight:400,approvedWeight:400,style:metadata.style}]});
  const post=async(path,value)=>{const r=await request(path,{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40),'content-type':'application/json'},body:JSON.stringify(value)});expect(r.status,r.bytes.toString()).toBe(200);return JSON.parse(r.bytes).value;};
  const submitted=await post('/admin/fonts/releases/'+f.id+'/submit-review',mutation(f.revision,{manifestDigest:f.manifestDigest}));
  const report=await post('/admin/fonts/reviews/'+submitted.reviewId+'/run',mutation(submitted.revision,{manifestDigest:f.manifestDigest}));expect(report.report.ok,JSON.stringify(report)).toBe(true);
  const pdf=await request('/admin/fonts/reviews/'+submitted.reviewId+'/artifacts/'+report.report.faces[0].artifactHash,{headers:{authorization:'Bearer '+'a'.repeat(40)}});expect(pdf.status).toBe(200);expect(pdf.bytes.subarray(0,5).toString()).toBe('%PDF-');await writeFile('/results/app/admin-specimen.pdf',pdf.bytes);await writeFile('/results/app/admin-http.json',JSON.stringify(report));
 }finally{await inspect.stop();}
},60000);
it('cancels an actual task renderer on client disconnect, releases its DB slot after stop, and accepts a retry',async()=>{
 const launcher=await spy.mock.results[0].value,original=launcher.spawnBlocked;let handle,placed=false;
 const pause=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{const h=await original(spec);if(spec.kind!=='task-render')return h;handle=h;return {...h,async start(){await h.start();process.kill(h.identity.pid,'SIGSTOP');placed=true;}};});
 const abort=new AbortController();let pending;
 try{
  const previous=new Set((await pool.query('SELECT id FROM tasks')).rows.map(r=>r.id));pending=request('/documents',{method:'POST',signal:abort.signal,headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':'docx-small','output-format':'pdf',accept:'multipart/mixed'},body:await body(0,'Cancelled ไทย EN')}).then(v=>({value:v}),e=>({error:e.name}));
  const end=Date.now()+10000;let row;while(true){row=(await pool.query("SELECT * FROM tasks WHERE status='processing' AND child_pid IS NOT NULL")).rows.find(r=>!previous.has(r.id));if(row&&placed)break;if(Date.now()>end)throw Error('task cancellation did not reach renderer');await wait(20);}
  abort.abort();expect((await pending).error).toBe('AbortError');const stopped=Date.now()+10000;let reservation;
  do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[row.id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[row.id])).rows[0];if(row.status==='failed'&&!reservation.queue_slot_held&&handle.state==='stopped')break;await wait(20);}while(Date.now()<stopped);
  expect(row.status).toBe('failed');expect(reservation.queue_slot_held).toBe(false);expect(handle.state).toBe('stopped');expect((await pool.query('SELECT count(*) FROM generation_jobs WHERE task_id=$1',[row.id])).rows[0].count).toBe('1');await writeFile('/results/app/task-client-cancel.json',JSON.stringify({row,reservation,stopProof:await handle.waitStopped()}));
 }finally{abort.abort();await pending;pause.mockRestore();}
 const retry=await request('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':'docx-small','output-format':'pdf',accept:'multipart/mixed'},body:await body(0,'Retry ไทย EN')});expect(retry.status).toBe(200);expect(artifact([retry.bytes]).bytes.subarray(0,5).toString()).toBe('%PDF-');
},30000);
it('handles gate death after bind through real HTTP without poisoning health or retaining worker grants',async()=>{
 const launcher=await spy.mock.results[0].value,original=launcher.spawnBlocked;let injected=false,deadHandle;const launches=[];
 const fault=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{const h=await original(spec);if(spec.kind!=='legacy-render')return h;const jobs=(await pool.query("SELECT id FROM generation_jobs WHERE status='running'")).rows;expect(jobs).toHaveLength(1);launches.push(jobs[0].id);if(injected)return h;injected=true;deadHandle=h;return {...h,async bind(){const proof=await h.bind(),closed=new Promise(r=>h.child.once('close',r));process.kill(h.identity.pid,'SIGKILL');await closed;return proof;}};});
 const submit=async()=>{const r=await request('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture(19,'p5-model19').request)});expect(r.status,r.bytes.toString()).toBe(202);return JSON.parse(r.bytes).value.jobId;};
 const terminal=async id=>{const end=Date.now()+10000;while(true){const row=(await pool.query('SELECT * FROM generation_jobs WHERE id=$1',[id])).rows[0];if(['failed','succeeded'].includes(row.status))return row;if(Date.now()>end)throw Error('P5-01 HTTP task did not terminate');await wait(20);}};
 try{
  const failedId=await submit();expect((await terminal(failedId)).status).toBe('failed');expect(await deadHandle.waitStopped()).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});const end=Date.now()+5000;while(intake.processingContext.resources.snapshot().workers&&Date.now()<end)await wait(20);expect(intake.processingContext.resources.snapshot()).toMatchObject({workers:0,creditsMiB:128});expect((await request('/health')).status).toBe(200);await wait(500);expect(launches.filter(id=>id===failedId)).toHaveLength(1);
  const nextId=await submit();expect((await terminal(nextId)).status).toBe('succeeded');const pdf=await request('/jobs/'+nextId+'/pdf');expect(pdf.status).toBe(200);expect(pdf.bytes.subarray(0,5).toString()).toBe('%PDF-');await writeFile('/results/app/p501-post-failure.pdf',pdf.bytes);await writeFile('/results/app/p501-http.json',JSON.stringify({failedId,nextId,launches,health:200,credits:intake.processingContext.resources.snapshot(),stopped:true,noResendObservationMs:500,actualDefaultPayload:true}));
 }finally{fault.mockRestore();}
},30000);
});
