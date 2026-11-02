import {describe,beforeAll,afterAll,it,expect,vi} from 'vitest';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {prepareP5Lab} from './helpers/worker-p5-lab.mjs';
import {nativeModel20,multipart,contentType} from './helpers/model20-native.mjs';
import {artifact} from './taskDocxFixture.mjs';

describe.skipIf(process.env.FLOWDOC_WORKER_LAB!=='1')('model20 nonempty instance diagnostics over real HTTP',()=>{
 const fixture=nativeModel20({images:true,key:'m20-diagnostics'}),duplicate=nativeModel20({images:true,key:'m20-diag-duplicate'}),failure=nativeModel20({images:true,key:'m20-diag-after-finding-unsupported'}),BASE='http://127.0.0.1:31841',events=[],captures=new Map(),handles=new Map();
 const a=duplicate.t.sections[0].source.fragment;a.rootIds.push('photo2');a.nodes.photo2={...structuredClone(a.nodes.photo),id:'photo2'};
 Object.assign(failure.t.sections[1].source.fragment.nodes.text.props,{heightMode:'fixed',height:{value:24,unit:'pt'}});
 const hash=b=>createHash('sha256').update(b).digest('hex'),wait=ms=>new Promise(r=>setTimeout(r,ms));
 let pool,service,intake,root,launcherSpy,intakeSpy,observe;
 const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
 async function request(path,options={}){const r=await fetch(BASE+path,options);return{status:r.status,bytes:Buffer.from(await r.arrayBuffer())};}
 async function lookup(id){const r=await request('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':'application/json'},body:JSON.stringify({taskId:id,findingsLimit:1})});expect(r.status).toBe(200);return JSON.parse(r.bytes);}
 beforeAll(async()=>{
  await prepareP5Lab();root=await mkdtemp('/results/app/m20-diag-');
  Object.assign(process.env,{FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json',TASK_QUEUE_PROFILE:'1g-2cpu',TASK_CREDENTIALS_FILE:root+'/credentials.json',TASK_STORAGE_DIR:root+'/tasks',EXPORT_TEMP_DIR:root+'/temp',EXPORT_OUTPUT_DIR:root+'/outputs',UPLOAD_STAGING_DIR:root+'/staging',FONT_ADMIN_TOKEN:'b'.repeat(40),FONT_ADMIN_PRINCIPAL:'font-test-admin',FONT_STORAGE_DIR:root+'/fonts',HOST:'127.0.0.1',PORT:'31841'});
  await writeFile(process.env.TASK_CREDENTIALS_FILE,JSON.stringify([{token:'t'.repeat(40),ownerKey:'lab',principalId:'lab',docKeys:[fixture.t.docKey,duplicate.t.docKey,failure.t.docKey],taskRead:true}]));
  pool=(await import('../dist/db/connection.js')).createPool(process.env.DATABASE_URL);ok(await(await import('../dist/db/migrate.js')).migrate(pool));for(const f of [fixture,duplicate,failure])ok(await(await import('../dist/templates/registry.js')).registerTemplate(pool,JSON.stringify(f.t)));
  const mod=await import('../dist/workers/launcher.js'),original=mod.createWorkerLauncher;
  launcherSpy=vi.spyOn(mod,'createWorkerLauncher').mockImplementation((c,d={})=>original(c,{...d,onGateEvent:e=>{events.push(e);appendFileSync('/results/app/diag-gates.jsonl',JSON.stringify(e)+'\n');}}));
  const m=await import('../dist/tasks/intake.js'),orig=m.createTaskIntake;intakeSpy=vi.spyOn(m,'createTaskIntake').mockImplementation(async(...args)=>{intake=await orig({...args[0],...(process.env.FLOWDOC_DIAG_CAP==='1'?{policy:{...args[0].policy,findingDetails:1}}:{})});return intake;});
  service=await(await import('../dist/server.js')).startService();expect((await request('/health')).status).toBe(200);
  const launcher=await launcherSpy.mock.results[0].value,spawn=launcher.spawnBlocked;
  observe=vi.spyOn(launcher,'spawnBlocked').mockImplementation(async spec=>{
   let taskId;if(spec.kind==='task-render'){
    const rows=(await pool.query("SELECT * FROM tasks WHERE status='processing' AND normalized_file_id IS NOT NULL")).rows;expect(rows).toHaveLength(1);const row=rows[0];taskId=row.id;
    const files=(await pool.query('SELECT * FROM task_files WHERE task_id=$1 ORDER BY part_order',[taskId])).rows,nf=files.find(f=>f.id===row.normalized_file_id);
    captures.set(taskId,{row,files,normalized:JSON.parse(await readFile(await intake.processingContext.files.path(nf.storage_key),'utf8'))});
   }
   const h=await spawn(spec);if(taskId)handles.set(taskId,h);return h;
  });
 },45000);
 afterAll(async()=>{await service?.stop();observe?.mockRestore();launcherSpy?.mockRestore();intakeSpy?.mockRestore();await pool?.end();await writeFile('/results/app/diag-observations.json',JSON.stringify({events,captures:[...captures]}));});
 async function input(stage,badIndex){
  const {sources}=await multipart(fixture.raw,{images:true}),parts=[];
  const part=(name,bytes,type)=>Buffer.concat([Buffer.from('--m20-native\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+type+'\r\n\r\n'),bytes,Buffer.from('\r\n')]);
  parts.push(part('payload',Buffer.from(JSON.stringify(fixture.raw)),'application/json'));
  for(const source of sources){
   if((source.index===badIndex&&stage==='normalization'||stage==='mixed'&&source.index===0))continue;
   const bytes=Buffer.from(source.bytes);
   if((source.index===badIndex&&stage==='preparation'||stage==='mixed'&&source.index===2)){
    let changed=false;for(let at=8;at<bytes.length;){const n=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT'){bytes[at+8]^=255;changed=true;break;}at+=12+n;}
    expect(changed).toBe(true);expect((await sharp(bytes).metadata()).format).toBe('png');await expect(sharp(bytes).raw().toBuffer()).rejects.toThrow();
   }
   parts.push(part('/sections/'+source.index+'/assets/0/image',bytes,'image/png'));
  }
  return Buffer.concat([...parts,Buffer.from('--m20-native--\r\n')]);
 }
 const cases=[['normalization',0,'pdf'],['normalization',2,'pdf'],['preparation',0,'pdf'],['preparation',2,'pdf'],['normalization',0,'docx'],['preparation',0,'docx']];
 it.each(cases)('%s finding in index%s with %s stays instance-scoped',async(stage,badIndex,format)=>{
  const name=stage+'-'+badIndex+'-'+format,badOwner=badIndex===0?'instance-first':'instance-last',goodOwner=badIndex===0?'instance-last':'instance-first';
  const r=await request('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':fixture.t.docKey,'output-format':format,accept:'multipart/mixed'},body:await input(stage,badIndex)});await writeFile('/results/app/'+name+'-wire.bin',r.bytes);expect(r.status,r.bytes.toString()).toBe(200);
  const id=r.bytes.toString().match(/"taskId":"([^"]+)"/)?.[1];expect(id).toBeTruthy();const end=Date.now()+10000;let row,reservation;
  do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[id])).rows[0];if(row.terminal_at&&!reservation.queue_slot_held&&Number(reservation.storage_held_bytes)===Number(reservation.storage_used_bytes)&&handles.get(id)?.state==='stopped')break;await wait(20);}while(Date.now()<end);
  const findings=(await pool.query('SELECT * FROM task_findings WHERE task_id=$1 ORDER BY sequence',[id])).rows,view=await lookup(id),captured=captures.get(id);
  await writeFile('/results/app/'+name+'.json',JSON.stringify({stage,badIndex,format,badOwner,goodOwner,row,reservation,findings,view,captured,stopProof:await handles.get(id)?.waitStopped()}));
  expect(findings).toHaveLength(1);const f=findings[0],code=stage==='normalization'?'IMAGE_SOURCE_MISSING':'IMAGE_UNUSABLE',pointer='/sections/'+badIndex+(stage==='normalization'?'/data/photo':'/assets/0');
  expect(f).toMatchObject({code,section_id:badOwner,pointer});expect(Number(f.affected_placement_count)).toBe(1);expect(findings.some(x=>x.section_id===goodOwner)).toBe(false);expect(view.findings).toHaveLength(1);expect(view.findings[0]).toMatchObject({code,sectionId:badOwner,path:pointer,affectedPlacements:1,action:'skipped'});expect(view.nextCursor).toBeNull();
  const original=captured.files.filter(x=>x.role==='original_image');expect(original.every(x=>x.asset_key==='tiny')).toBe(true);expect(new Set(original.map(x=>x.section_id))).toEqual(new Set(stage==='normalization'?[goodOwner]:[badOwner,goodOwner]));
  expect(captured.normalized.summary).toMatchObject({findingCount:stage==='normalization'?1:0,omittedPlacementCount:stage==='normalization'?1:0});
  if(stage==='preparation'){expect(f.detail.stage).toBe('preparation');expect(f.detail.nodeIdsSample.length).toBe(1);expect(f.detail.nodeIdsSample[0]).toContain(badOwner);}
  expect(reservation.queue_slot_held).toBe(false);expect(row.child_pid).toBeNull();expect(Number(reservation.storage_held_bytes)).toBe(Number(reservation.storage_used_bytes));let actual=0;for(const file of(await pool.query('SELECT * FROM task_files WHERE task_id=$1',[id])).rows)if(file.storage_key)actual+=await intake.processingContext.files.size(file.storage_key);expect(Number(reservation.storage_used_bytes)).toBe(actual);
  expect(row.status).toBe('succeeded');expect(view.task).toMatchObject({generation:'succeeded',delivery:'succeeded',completeness:'partial'});expect(view.task.counts).toMatchObject({findingCount:1,omittedImagePlacements:1});
  const file=artifact([r.bytes]);await writeFile('/results/app/'+name+'.'+format,file.bytes);await writeFile('/results/app/'+name+'-receipt.json',JSON.stringify({sha256:hash(file.bytes),bytes:file.bytes.length}));expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');
  expect((await request('/health')).status).toBe(200);
 },30000);
 async function extraCase(name,format,mixed=false){
  const r=await request('/documents',{method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40),'content-type':contentType,'doc-key':mixed?failure.t.docKey:duplicate.t.docKey,'output-format':format,accept:'multipart/mixed'},body:await input(mixed?'mixed':'preparation',0)});expect(r.status).toBe(200);await writeFile('/results/app/'+name+'-wire.bin',r.bytes);const id=r.bytes.toString().match(/"taskId":"([^"]+)"/)[1],end=Date.now()+10000;let row,reservation;
  do{row=(await pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];reservation=(await pool.query('SELECT * FROM task_resource_reservations WHERE task_id=$1',[id])).rows[0];if(row.terminal_at&&!reservation.queue_slot_held&&Number(reservation.storage_held_bytes)===Number(reservation.storage_used_bytes)&&handles.get(id)?.state==='stopped')break;await wait(20);}while(Date.now()<end);
  const view=await lookup(id),findings=(await pool.query('SELECT * FROM task_findings WHERE task_id=$1 ORDER BY sequence',[id])).rows,events=(await pool.query("SELECT * FROM task_events WHERE task_id=$1 AND event_type='preparation-finding' ORDER BY sequence",[id])).rows;await writeFile('/results/app/'+name+'.json',JSON.stringify({row,reservation,view,findings,events,captured:captures.get(id),stopProof:await handles.get(id).waitStopped()}));
  expect(view.task.counts).toMatchObject({findingCount:mixed?2:1,omittedImagePlacements:2});expect(events).toHaveLength(1);expect(events[0].detail).toMatchObject({version:1,findingCount:1,omittedPlacementCount:mixed?1:2});expect(findings).toHaveLength(1);expect(view.findings).toHaveLength(1);expect(view.task.detailsTruncated).toBe(mixed);expect(reservation.queue_slot_held).toBe(false);expect(row.child_pid).toBeNull();expect(Number(reservation.storage_held_bytes)).toBe(Number(reservation.storage_used_bytes));let actual=0;for(const f of(await pool.query('SELECT * FROM task_files WHERE task_id=$1',[id])).rows)if(f.storage_key)actual+=await intake.processingContext.files.size(f.storage_key);expect(Number(reservation.storage_used_bytes)).toBe(actual);
  if(mixed){expect(row.resource_policy.findingDetails).toBe(1);expect(view.findings[0]).toMatchObject({sectionId:'instance-first',affectedPlacements:1});expect(row.generation_summary).toBeNull();}else{expect(view.findings[0]).toMatchObject({sectionId:'instance-first',affectedPlacements:2});expect(Number(findings[0].affected_placement_count)).toBe(2);}
  if(!mixed){expect(row.status).toBe('succeeded');const file=artifact([r.bytes]);await writeFile('/results/app/'+name+'.'+format,file.bytes);expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');expect(row.generation_summary).toMatchObject({findingCount:1,preparationOmittedPlacementCount:2,imagePlacementCount:4});}
  else{expect(row.status).toBe('failed');expect(view.task.output).toBeNull();expect(r.bytes.toString()).toContain('DOCX_UNSUPPORTED');expect(r.bytes.toString()).not.toContain('Content-Disposition: attachment;');}

 }
 it.each(['pdf','docx'])('counts a shared bad asset affecting two placements exactly once with %s',async format=>extraCase('multiple-'+format,format),30000);
 it.skipIf(process.env.FLOWDOC_DIAG_CAP!=='1')('capped mixed normalization/preparation retains uncapped failure totals',async()=>extraCase('capped-mixed-docx','docx',true),30000);

});
