import {releaseSet,mutation} from './fontLifecycleFixture.mjs';
import {createFontLifecycle} from '../dist/fonts/lifecycle.js';
import {Pool} from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {stageFont} from './fontFixture.mjs';
import {createAuthoring} from '../dist/authoring/service.js';
import {startProcessor} from '../dist/jobs/processor.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL}),root='/app/staging/font-job-persistence';process.env.FONT_STORAGE_DIR=root;
const ok=r=>{assert(r.ok,JSON.stringify(r));return r.value;},mode=process.argv[2];
try{
 const api=createAuthoring(pool,'persistent-owner',{maxOutstanding:10,imagesEnabled:false});
 if(mode==='write'){
  const f=await releaseSet(pool,root,await stageFont(pool,root,process.env.FONT_FIXTURE_DIR?join(process.env.FONT_FIXTURE_DIR,'Pridi','Pridi-Regular.ttf'):'Sarabun-Regular.ttf'));const life=createFontLifecycle({pool,root,principal:'font-test-admin'});await life.setDefault(f.familyId,mutation(0,{releaseId:f.id}));
  const id=ok(await api.create({name:'Pinned fonts',docKey:'persist-font-job',idempotencyKey:'create'}));
  const definition=JSON.parse(await readFile('examples/area-document-template.json','utf8'));Object.assign(definition,{schemaVersion:2,templateId:id.templateId,docKey:id.docKey});
  for(const [k,s] of Object.entries(definition.styles))definition.styles[k]={font:f.fontSelection,fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};
  definition.areaFormats.meeting.fragment.nodes.beforeText.children[0].text='ภาษาไทย กุ้ง น้ำ ปี่ — Pinned font';
  const saved=ok(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'save'}));assert.equal(saved.fontReadiness.status,'ready');
  const request={...JSON.parse(await readFile('examples/area-document-request.json','utf8')),docKey:id.docKey};
  const job=ok(await api.preview(id.templateId,{expectedRevision:1,sampleRequest:request,idempotencyKey:'preview'}));
  const row=(await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[job.jobId])).rows[0];
  await writeFile(root+'/proof.json',JSON.stringify({jobId:job.jobId,templateId:id.templateId,releaseId:f.id,releaseRevision:f.revision,familyId:f.familyId,snapshot:row.snapshot}));
 }else if(mode==='read'){
  const proof=JSON.parse(await readFile(root+'/proof.json','utf8')),row=(await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[proof.jobId])).rows[0];assert.deepEqual(row.snapshot,proof.snapshot);
  const life=createFontLifecycle({pool,root,principal:'font-test-admin'});await life.retire(proof.releaseId,mutation(proof.releaseRevision,{expectedFamilyRevision:1,clearDefault:true}));assert.equal((await pool.query('SELECT default_release_id FROM font_families WHERE id=$1',[proof.familyId])).rows[0].default_release_id,null);
  const saved=ok(await api.get(proof.templateId));assert.equal(saved.fontReadiness.status,'ready');
  for(const style of Object.values(saved.definition.styles))style.font={kind:'unselected'};
  assert.equal(ok(await api.save(proof.templateId,{definition:saved.definition,expectedRevision:saved.revision,idempotencyKey:'after-queue'})).fontReadiness.status,'blocked');
  let bytes;const processor=await startProcessor({pool,pollMs:10,policy:{retain:true,ttlHours:24,tempHours:24},files:{writePdf:async(id,b)=>{bytes=b;return {path:id+'.pdf',byteSize:b.length};}}});
  try{let status;for(let i=0;i<600;i++){status=(await pool.query('SELECT status,errors_json FROM generation_jobs WHERE id=$1',[proof.jobId])).rows[0];if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(status.status,'succeeded',JSON.stringify(status));}finally{await processor.stop();}
  await writeFile('/evidence/pinned-after-db-restart.pdf',bytes);
  await writeFile('/evidence/job-restart-result.json',JSON.stringify({status:'PASS',snapshotUnchanged:true,retiredStillReady:true,newDraftBlockedOldJobPinned:true,jobSucceeded:true,pdfSha256:createHash('sha256').update(bytes).digest('hex'),snapshot:proof.snapshot},null,2));
 }else throw Error('write/read');
 console.log(JSON.stringify({status:'PASS',mode}));
}finally{await pool.end();}
