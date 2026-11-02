import {describe,beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {validateTemplate,prepareGeneration,normalizeTaskInput} from '@flowdoc/core';
import {prepareP5Lab} from './helpers/worker-p5-lab.mjs';
import {nativeModel20,multipart,contentType} from './helpers/model20-native.mjs';
import {artifact} from './taskDocxFixture.mjs';

describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('T1 real model20 A-B-A API',()=>{
 const BASE='http://127.0.0.1:31841',basic=nativeModel20(),image=nativeModel20({images:true,key:'m20-images'}),events=[],captures=[];
 const hash=b=>createHash('sha256').update(b).digest('hex'),wait=ms=>new Promise(r=>setTimeout(r,ms));
 let pool,service,root,spy,intakeSpy,intake;
 const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
 async function call(path,options={}){const r=await fetch(BASE+path,options);return{status:r.status,headers:Object.fromEntries(r.headers),bytes:Buffer.from(await r.arrayBuffer())};}
 const json=r=>JSON.parse(r.bytes);
 const author=(method,path,value)=>call(path,{method,headers:{authorization:'Bearer '+'a'.repeat(40),'content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});
 async function terminal(id){const end=Date.now()+20000;while(Date.now()<end){const row=(await pool.query('SELECT * FROM generation_jobs WHERE id=$1',[id])).rows[0];if(['failed','succeeded'].includes(row?.status))return row;await wait(25);}throw Error('T1 job timeout');}
 async function savePdf(name,r){expect(r.status,r.bytes.toString()).toBe(200);expect(r.bytes.subarray(0,5).toString()).toBe('%PDF-');expect(r.bytes.toString('latin1')).toContain('%%EOF');await writeFile('/results/app/'+name+'.pdf',r.bytes);return{bytes:r.bytes.length,sha256:hash(r.bytes)};}
 beforeAll(async()=>{
  await prepareP5Lab();root=await mkdtemp('/results/app/t1-http-');
  Object.assign(process.env,{FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json',TASK_QUEUE_PROFILE:'1g-2cpu',TASK_CREDENTIALS_FILE:root+'/credentials.json',TASK_STORAGE_DIR:root+'/tasks',EXPORT_TEMP_DIR:root+'/temp',EXPORT_OUTPUT_DIR:root+'/outputs',UPLOAD_STAGING_DIR:root+'/staging',AUTHORING_TOKEN:'a'.repeat(40),AUTHORING_PRINCIPAL:'t1-owner',FONT_ADMIN_TOKEN:'b'.repeat(40),FONT_ADMIN_PRINCIPAL:'font-test-admin',FONT_STORAGE_DIR:root+'/fonts',HOST:'127.0.0.1',PORT:'31841'});
  await writeFile(process.env.TASK_CREDENTIALS_FILE,JSON.stringify([{token:'t'.repeat(40),ownerKey:'lab',principalId:'lab',docKeys:[basic.t.docKey,image.t.docKey],taskRead:true}]));
  pool=(await import('../dist/db/connection.js')).createPool(process.env.DATABASE_URL);ok(await(await import('../dist/db/migrate.js')).migrate(pool));
  for(const f of [basic,image])ok(await(await import('../dist/templates/registry.js')).registerTemplate(pool,JSON.stringify(f.t)));
  const mod=await import('../dist/workers/launcher.js'),original=mod.createWorkerLauncher;
  spy=vi.spyOn(mod,'createWorkerLauncher').mockImplementation((c,d={})=>original(c,{...d,onGateEvent:e=>{events.push(e);appendFileSync('/results/app/t1-gates.jsonl',JSON.stringify(e)+'\n');}}));
  const m=await import('../dist/tasks/intake.js'),orig=m.createTaskIntake;intakeSpy=vi.spyOn(m,'createTaskIntake').mockImplementation(async(...a)=>{intake=await orig(...a);return intake;});
  service=await(await import('../dist/server.js')).startService();
  const end=Date.now()+10000;while((await call('/health')).status!==200){if(Date.now()>end)throw Error('T1 readiness timeout');await wait(30);}
 },45000);
 afterAll(async()=>{await service?.stop();spy?.mockRestore();intakeSpy?.mockRestore();await pool?.end();await writeFile('/results/app/t1-observations.json',JSON.stringify({events,captures}));});
 it('renders published model20 over actual /jobs and retains prepared schema3 pin',async()=>{
  const p=ok(prepareGeneration(ok(validateTemplate(basic.t)),basic.request));expect(p.schemaVersion).toBe(3);
  const r=await call('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(basic.request)});expect(r.status,r.bytes.toString()).toBe(202);
  const id=json(r).value.jobId,row=await terminal(id);await writeFile('/results/app/t1-legacy-job.json',JSON.stringify(row));expect(row.status,JSON.stringify(row)).toBe('succeeded');expect(row.prepared_input).toEqual(p);
  await writeFile('/results/app/t1-legacy-receipt.json',JSON.stringify(await savePdf('t1-legacy',await call('/jobs/'+id+'/pdf'))));
 },30000);
 it('renders an accepted saved revision while a subsequent draft edit stays isolated',async()=>{
  const created=await author('POST','/authoring/drafts',{name:'T1 preview',docKey:'m20-preview',idempotencyKey:randomUUID()});expect(created.status,created.bytes.toString()).toBe(201);const identity=json(created).value;
  const definition=structuredClone(basic.t);Object.assign(definition,{templateId:identity.templateId,docKey:identity.docKey,name:identity.name});const url='/authoring/drafts/'+identity.templateId;
  const saved=await author('PUT',url,{definition,expectedRevision:0,idempotencyKey:randomUUID()});expect(saved.status,saved.bytes.toString()).toBe(200);
  const launcher=await spy.mock.results[0].value,orig=launcher.spawnBlocked;let release,held;const barrier=new Promise(r=>release=r);
  const pause=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{const h=await orig(spec);if(spec.kind!=='legacy-render')return h;held=h;return{...h,async start(){await barrier;await h.start();}};});
  try{
   const r=await author('POST',url+'/previews',{expectedRevision:1,sampleRequest:{...basic.request,docKey:identity.docKey},idempotencyKey:randomUUID()});expect(r.status,r.bytes.toString()).toBe(202);const id=json(r).value.jobId;
   const end=Date.now()+10000;while(!held){if(Date.now()>end)throw Error('preview barrier timeout');await wait(20);}
   const edited=structuredClone(definition);edited.sections[0].source.fragment.nodes.text.children=[{id:'edited',type:'text',text:'EDITED-NEW-REV'}];const next=await author('PUT',url,{definition:edited,expectedRevision:1,idempotencyKey:randomUUID()});expect(next.status,next.bytes.toString()).toBe(200);release();
   const row=await terminal(id);expect(row.status,JSON.stringify(row)).toBe('succeeded');expect(row.preview_revision).toBe(1);expect(row.preview_definition).toEqual(definition);await writeFile('/results/app/t1-preview-pin.json',JSON.stringify({row,editedRevision:json(next).value.revision}));await savePdf('t1-preview',await author('GET','/authoring/previews/'+id+'/pdf'));
  }finally{release();pause.mockRestore();}
 },40000);
 it('streams model20 PDF/DOCX with instance-scoped same-key images through /documents',async()=>{
  const launcher=await spy.mock.results[0].value,orig=launcher.spawnBlocked;
  const observe=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{
   if(spec.kind==='task-render'){
    const rows=(await pool.query("SELECT * FROM tasks WHERE status='processing' AND normalized_file_id IS NOT NULL")).rows;
    expect(rows).toHaveLength(1);const row=rows[0],files=(await pool.query('SELECT * FROM task_files WHERE task_id=$1 ORDER BY part_order',[row.id])).rows;
    const nf=files.find(f=>f.id===row.normalized_file_id),normalized=JSON.parse(await readFile(await intake.processingContext.files.path(nf.storage_key),'utf8'));
    captures.push({row,files,normalized});await writeFile('/results/app/t1-normalized-'+row.output_format+'.json',JSON.stringify(captures.at(-1)));
   }
   return orig(spec);
  });
  try{for(const format of ['pdf','docx']){
   const input=await multipart(image.raw,{images:true}),r=await call('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':image.t.docKey,'output-format':format,accept:'multipart/mixed'},body:input.bytes});await writeFile('/results/app/t1-task-'+format+'-wire.bin',r.bytes);expect(r.status,r.bytes.toString()).toBe(200);
   const file=artifact([r.bytes]);await writeFile('/results/app/t1-task.'+format,file.bytes);await writeFile('/results/app/t1-task-'+format+'-receipt.json',JSON.stringify({sha256:hash(file.bytes),bytes:file.bytes.length,headers:file.headers,sources:input.sources.map(s=>({index:s.index,sha256:hash(s.bytes)}))}));
   expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');
   const captured=captures.at(-1),originals=captured.files.filter(f=>f.role==='original_image');expect(originals).toHaveLength(2);expect(new Set(originals.map(f=>f.checksum)).size).toBe(2);expect(new Set(originals.map(f=>f.section_id)).size).toBe(2);
   expect(captured.normalized.version).toBe(2);expect(captured.normalized.input.contract).toBe('flowdoc-task-input/2');expect(captured.normalized.input.sections.map(s=>s.instanceKey)).toEqual(['first','middle','last']);expect(originals.map(f=>f.section_id).sort()).toEqual(['instance-first','instance-last']);expect(originals.every(f=>f.asset_key==='tiny')).toBe(true);expect(captured.normalized.summary).toMatchObject({completeness:'complete',findingCount:0,assetCount:2,placementCount:2,omittedPlacementCount:0});
   const end=Date.now()+5000;let row,reservation;do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[captured.row.id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[row.id])).rows[0];if(row.status==='succeeded'&&!reservation.queue_slot_held)break;await wait(20);}while(Date.now()<end);
   await writeFile('/results/app/t1-task-'+format+'-final.json',JSON.stringify({row,reservation}));expect(row.status,JSON.stringify(row)).toBe('succeeded');expect(reservation.queue_slot_held).toBe(false);
  }}finally{observe.mockRestore();}
 },60000);
 it('uses an actually inspected, reviewed library font and does not grant a copied retired tuple',async()=>{
  const launcher=await spy.mock.results[0].value,{createFontInspector}=await import('../dist/fonts/inspection.js'),inspect=createFontInspector(launcher),fontPath='/candidate/node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf';
  const metadata=await inspect(fontPath),font=await readFile(fontPath),license=await readFile('/candidate/node_modules/@flowdoc/core/assets/fonts/OFL.txt');
  const lib=await(await import('../dist/fonts/service.js')).createFontLibrary({pool,root:root+'/fonts',principal:'font-test-admin',inspect});
  const mutation=(revision,extra={})=>({requestId:randomUUID(),reason:'T1 isolated provenance proof',expectedRevision:revision,...extra});
  const post=async(path,value)=>{const r=await call(path,{method:'POST',headers:{authorization:'Bearer '+'b'.repeat(40),'content-type':'application/json'},body:JSON.stringify(value)});expect(r.status,r.bytes.toString()).toBe(200);return json(r).value;};
  try{
   const family=await lib.createFamily({requestId:randomUUID(),reason:'T1 lab',displayName:'T1 Sarabun',internalNames:[metadata.names.family],sourceIdentity:{provider:'google-fonts',providerFamilyKey:randomUUID()}});
   const imp=await lib.createImport({requestId:randomUUID(),reason:'T1 lab',files:[{clientKey:'font',byteLength:font.length,sha256:hash(font)}],licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:hash(license)}],sourceEvidence:[{clientKey:'font',provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'b'.repeat(64),fileHashBinding:hash(font),sourceWeight:400,licenseClientKeys:['license']}]});
   await lib.receive(imp.id,'font',(async function*(){yield font;})());await lib.receive(imp.id,'license',(async function*(){yield license;})());
   const checked=await lib.inspectImport(imp.id,mutation(0)),entry=checked.files.find(f=>f.clientKey==='font');const f=await lib.stageRelease({requestId:randomUUID(),reason:'T1 lab',familyId:family.id,version:1,importId:imp.id,languageScope:['th','en'],faceBindings:[{assetId:entry.assetId,sourceEvidenceId:entry.sourceEvidenceId,sourceWeight:400,approvedWeight:400,style:metadata.style}]});
   const submitted=await post('/admin/fonts/releases/'+f.id+'/submit-review',mutation(f.revision,{manifestDigest:f.manifestDigest})),report=await post('/admin/fonts/reviews/'+submitted.reviewId+'/run',mutation(submitted.revision,{manifestDigest:f.manifestDigest}));expect(report.report.ok,JSON.stringify(report)).toBe(true);
   const approved=await post('/admin/fonts/reviews/'+submitted.reviewId+'/approve',mutation(report.revision,{manifestDigest:f.manifestDigest,reportDigest:report.reportDigest,artifactHashes:report.report.faces.map(x=>x.artifactHash)}));const active=await post('/admin/fonts/releases/'+f.id+'/activate',mutation(approved.revision,{reviewId:submitted.reviewId,manifestDigest:f.manifestDigest}));
   const create=async key=>{const r=await author('POST','/authoring/drafts',{name:'T1 library '+key,docKey:key,idempotencyKey:randomUUID()});expect(r.status,r.bytes.toString()).toBe(201);return json(r).value;};
   const own=await create('m20-library'),t=structuredClone(basic.t);Object.assign(t,{schemaVersion:2,templateId:own.templateId,docKey:own.docKey,name:own.name});const style=t.styles.body;t.styles.body={font:{kind:'library',releaseId:f.id,weight:400,style:'normal'},fontSize:style.fontSize,lineHeightPt:style.lineHeightPt};
   const saved=await author('PUT','/authoring/drafts/'+own.templateId,{definition:t,expectedRevision:0,idempotencyKey:randomUUID()});expect(saved.status,saved.bytes.toString()).toBe(200);expect(json(saved).value.fontReadiness.status).toBe('ready');
   const retired=await post('/admin/fonts/releases/'+f.id+'/retire',mutation(active.revision));
   const copy=await create('m20-library-copy'),copied={...structuredClone(t),templateId:copy.templateId,docKey:copy.docKey,name:copy.name};const rejected=await author('PUT','/authoring/drafts/'+copy.templateId,{definition:copied,expectedRevision:0,idempotencyKey:randomUUID()});expect(rejected.status,rejected.bytes.toString()).toBe(200);expect(json(rejected).value.fontReadiness.status).toBe('blocked');
   const {readReferences}=await import('../dist/fonts/retention.js'),ownRefs=await readReferences(pool,own.templateId,1),copyRefs=await readReferences(pool,copy.templateId,1);expect(ownRefs.bindings).toEqual([{releaseId:f.id,weight:400,style:'normal'}]);expect(copyRefs.bindings).toEqual([]);
   const invalid=await author('POST','/authoring/drafts/'+copy.templateId+'/previews',{expectedRevision:1,sampleRequest:{...basic.request,docKey:copy.docKey},idempotencyKey:randomUUID()});expect(invalid.status).toBe(422);
   const r=await author('POST','/authoring/drafts/'+own.templateId+'/previews',{expectedRevision:1,sampleRequest:{...basic.request,docKey:own.docKey},idempotencyKey:randomUUID()});expect(r.status,r.bytes.toString()).toBe(202);const jobId=json(r).value.jobId;expect((await terminal(jobId)).status).toBe('succeeded');await savePdf('t1-schema2',await author('GET','/authoring/previews/'+jobId+'/pdf'));
   const snapshot=(await pool.query('SELECT * FROM job_font_snapshots WHERE job_id=$1',[jobId])).rows;expect(snapshot).toHaveLength(1);await writeFile('/results/app/t1-schema2-provenance.json',JSON.stringify({submitted,report,approved,active,retired,ownRefs,copyRefs,snapshot,rejected:json(invalid),jobId}));
  }finally{await inspect.stop();}
 },60000);
 it('interrupts one actual model20 worker and accepts an explicit retry with the same instance keys',async()=>{
  const launcher=await spy.mock.results[0].value,orig=launcher.spawnBlocked;let handle,placed=false;const launches=[];
  const pause=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{const h=await orig(spec);if(spec.kind!=='task-render')return h;const rows=(await pool.query("SELECT id FROM tasks WHERE status='processing' AND template_pin->>'docKey'=$1",[image.t.docKey])).rows;expect(rows).toHaveLength(1);launches.push(rows[0].id);if(placed)return h;handle=h;return{...h,async start(){await h.start();process.kill(h.identity.pid,'SIGSTOP');placed=true;}};});
  const input=await multipart(image.raw,{images:true}),headers={authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':image.t.docKey,'output-format':'pdf',accept:'multipart/mixed'},abort=new AbortController();let pending;
  try{
   const previous=new Set((await pool.query('SELECT id FROM tasks')).rows.map(x=>x.id));pending=call('/documents',{method:'POST',headers,body:input.bytes,signal:abort.signal}).then(value=>({value}),e=>({error:e.name}));const end=Date.now()+10000;let row;
   do{row=(await pool.query("SELECT * FROM tasks WHERE status='processing' AND child_pid IS NOT NULL")).rows.find(x=>!previous.has(x.id));if(row&&placed)break;await wait(20);}while(Date.now()<end);expect(placed).toBe(true);expect(row).toBeTruthy();abort.abort();expect((await pending).error).toBe('AbortError');
   const stopEnd=Date.now()+10000;let reservation;do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[row.id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[row.id])).rows[0];if(row.status==='failed'&&!reservation.queue_slot_held&&handle.state==='stopped'&&Number(reservation.storage_held_bytes)===Number(reservation.storage_used_bytes))break;await wait(20);}while(Date.now()<stopEnd);
   expect(row.status).toBe('failed');expect(reservation.queue_slot_held).toBe(false);expect(handle.state).toBe('stopped');expect(Number(reservation.storage_held_bytes)).toBe(Number(reservation.storage_used_bytes));expect(row.template_pin).toEqual(captures[0].row.template_pin);const stopProof=await handle.waitStopped();expect(stopProof).toEqual({childReaped:true,groupGone:true,scopeEmpty:true});
   let actual=0;for(const f of(await pool.query('SELECT * FROM task_files WHERE task_id=$1',[row.id])).rows)if(f.storage_key)actual+=await intake.processingContext.files.size(f.storage_key);expect(Number(reservation.storage_used_bytes)).toBe(actual);
   const status=await call('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':'application/json'},body:JSON.stringify({taskId:row.id})});expect(status.status).toBe(200);expect(json(status).task).toMatchObject({generation:'failed',delivery:'failed',deliveryEvidence:'not_started',output:null});await wait(500);expect(launches.filter(id=>id===row.id)).toHaveLength(1);expect((await pool.query('SELECT count(*) FROM generation_jobs WHERE task_id=$1',[row.id])).rows[0].count).toBe('1');expect((await pool.query('SELECT o.id FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1',[row.id])).rowCount).toBe(0);
   const retry=await call('/documents',{method:'POST',headers,body:input.bytes});expect(retry.status,retry.bytes.toString()).toBe(200);await writeFile('/results/app/t1-retry.pdf',artifact([retry.bytes]).bytes);expect(launches).toHaveLength(2);expect(launches[1]).not.toBe(row.id);
   let fresh,freshReservation;const freshEnd=Date.now()+5000;do{fresh=(await pool.query('SELECT * FROM tasks WHERE id=$1',[launches[1]])).rows[0];freshReservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[fresh.id])).rows[0];if(fresh.status==='succeeded'&&!freshReservation.queue_slot_held)break;await wait(20);}while(Date.now()<freshEnd);expect(fresh.status).toBe('succeeded');expect(fresh.template_pin).toEqual(row.template_pin);expect(fresh.input_digest).toBe(row.input_digest);expect(freshReservation.queue_slot_held).toBe(false);const grantTrace=[];const grantEnd=Date.now()+5000;do{const current=intake.processingContext.resources.snapshot();grantTrace.push({workers:current.workers,intakes:current.intakes,senders:current.senders,creditsMiB:current.creditsMiB});if(current.creditsMiB===128)break;await wait(20);}while(Date.now()<grantEnd);expect(intake.processingContext.resources.snapshot()).toMatchObject({workers:0,intakes:0,senders:0,creditsMiB:128});
   await writeFile('/results/app/t1-interruption.json',JSON.stringify({row,reservation,actual,stopProof,status:{http:status.status,body:json(status)},launches,fresh,freshReservation,grantTrace,noResendObservationMs:500,retrySha256:hash(artifact([retry.bytes]).bytes)}));
  }finally{abort.abort();await pending;pause.mockRestore();}
 },40000);
 it('keeps the 2000-instance and 50000-expansion bounds without native rendering a large document',async()=>{
  const memory=x=>({async byteLength(){return Buffer.byteLength(JSON.stringify(x));},async kind(){return Array.isArray(x)?'array':x!==null&&typeof x==='object'?'object':'scalar';},async scalar(){return x;},async *properties(){for(const[k,v]of Object.entries(x))yield[k,memory(v)];},async *elements(){for(const v of x)yield memory(v);}});
  const sections=Array.from({length:2000},(_,i)=>({...basic.raw.sections[0],instanceKey:'limit-'+i})),template=ok(validateTemplate(basic.t));
  expect(prepareGeneration(template,{...basic.request,sections}).ok).toBe(true);
  const normalize=async items=>{let bytes=0;const r=await normalizeTaskInput(template,memory({data:{},sections:items}),{write:async x=>{bytes+=Buffer.byteLength(x);},images:{async collect(){throw Error('unexpected image');},async seal(){},async resolve(){throw Error('unexpected image');}}});return{r,bytes};};
  const at=await normalize(sections);expect(at.r.ok,JSON.stringify(at)).toBe(true);const above=await normalize([...sections,{...sections[0],instanceKey:'above'}]);expect(above.r.ok).toBe(false);expect(above.r.issues[0].code).toBe('LIMIT_EXCEEDED');
  const before=events.length,tooMany=await author('POST','/authoring/validate',{definition:basic.t,sampleRequest:{...basic.request,sections:[...sections,{...sections[0],instanceKey:'above'}]}});expect(tooMany.status).toBe(422);expect(json(tooMany).issues[0].code).toBe('LIMIT_EXCEEDED');
  const expanded=structuredClone(basic.t);expanded.sections=[expanded.sections[0]];const fragment=expanded.sections[0].source.fragment;fragment.nodes={};fragment.rootIds=[];
  for(let i=0;i<26;i++){const id='block-'+i;fragment.rootIds.push(id);fragment.nodes[id]={id,type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf-'+i,type:'text',text:'bounded'}]};}
  ok(validateTemplate(expanded));const expansion=await author('POST','/authoring/validate',{definition:expanded,sampleRequest:{...basic.request,sections}});expect(expansion.status,expansion.bytes.toString()).toBe(422);expect(json(expansion).issues[0].code).toBe('EXPANSION_LIMIT');expect(events.length).toBe(before);
  await writeFile('/results/app/t1-bounds.json',JSON.stringify({at,above,instanceRoute:json(tooMany),expansionRoute:json(expansion),nativeLaunches:0,instances:2000,blocksPerInstance:26,cap:50000}));
 },30000);
 it('keeps actual native preflight contention as503 without inserting a job or starting a worker',async()=>{
  const lock=await pool.connect(),before=(await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count,launchesBefore=events.length;
  try{
   await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(60430407)');
   const r=await call('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(basic.request)});expect(r.status,r.bytes.toString()).toBe(503);expect(json(r).issues[0].code).toBe('UNAVAILABLE');expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(before);expect(events.length).toBe(launchesBefore);expect((await call('/health')).status).toBe(200);await writeFile('/results/app/t101-unavailable.json',JSON.stringify({http:r.status,body:json(r),nativeLaunches:0,jobsBefore:before,jobsAfter:before}));
  }finally{await lock.query('ROLLBACK');lock.release();}
 },10000);
 it('rejects invalid model20 assemblies through actual routes without a published output or leaked reservation',async()=>{
  const jobsBefore=(await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count;
  const bad=[['SECTION_INPUT_SHAPE',{}],['SECTION_ASSEMBLY_EMPTY',[]],['SECTION_INSTANCE_DUPLICATE',[basic.raw.sections[0],basic.raw.sections[0]]],['SECTION_KEY_UNKNOWN',[{...basic.raw.sections[0],sectionKey:'UNKNOWN'}]]],results=[];
  for(const [code,sections]of bad){
   const p=prepareGeneration(ok(validateTemplate(basic.t)),{...basic.request,sections});expect(p.ok).toBe(false);expect(p.issues[0].code).toBe(code);
   const legacy=await call('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...basic.request,sections})});expect.soft(legacy.status,legacy.bytes.toString()).toBe(422);expect(json(legacy).issues[0].code).toBe(code);
   const input=await multipart({data:{},sections}),r=await call('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':basic.t.docKey,'output-format':'pdf',accept:'multipart/mixed'},body:input.bytes});expect(r.status).toBe(200);expect(r.bytes.toString()).toContain('"code":"INVALID_DATA"');expect(r.bytes.toString()).not.toContain('Content-Disposition: attachment;');results.push({code,http:legacy.status,legacy:json(legacy),wire:r.bytes.toString()});
  }
  const settleEnd=Date.now()+5000;while(Date.now()<settleEnd){const pending=(await pool.query("SELECT count(*) n FROM tasks t JOIN task_resource_reservations r ON r.task_id=t.id WHERE t.template_pin->>'docKey'=$1 AND (r.queue_slot_held OR r.storage_held_bytes<>r.storage_used_bytes)",[basic.t.docKey])).rows[0].n;if(Number(pending)===0)break;await wait(20);}
  const rows=(await pool.query("SELECT t.*,r.storage_held_bytes,r.storage_used_bytes,r.queue_slot_held FROM tasks t JOIN task_resource_reservations r ON r.task_id=t.id WHERE t.template_pin->>'docKey'=$1",[basic.t.docKey])).rows;
  for(const row of rows){expect(row.status).toBe('failed');expect(row.queue_slot_held).toBe(false);expect(row.child_pid).toBeNull();expect(Number(row.storage_held_bytes)).toBe(Number(row.storage_used_bytes));const files=(await pool.query('SELECT * FROM task_files WHERE task_id=$1',[row.id])).rows;let actual=0;for(const f of files)if(f.storage_key)actual+=await intake.processingContext.files.size(f.storage_key);expect(Number(row.storage_used_bytes)).toBe(actual);expect((await pool.query('SELECT o.id FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1',[row.id])).rowCount).toBe(0);}
  expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe(jobsBefore);expect(rows).toHaveLength(4);await writeFile('/results/app/t1-invalid.json',JSON.stringify({results,rows}));
 },30000);

});
