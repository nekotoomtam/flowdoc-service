import {beforeAll,afterAll,it,expect} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createFontLifecycle} from '../dist/fonts/lifecycle.js';
import {createFontLibrary} from '../dist/fonts/service.js';
import {stageSet,releaseSet,mutation as m} from './fontLifecycleFixture.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAuthoring} from '../dist/authoring/service.js';
const db=isolatedDatabase(),pool=db.pool;let root,life,lib;
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(pool));root=await mkdtemp(join(tmpdir(),'font-lifecycle-'));process.env.FONT_STORAGE_DIR=root;life=createFontLifecycle({pool,root,principal:'font-test-admin'});lib=await createFontLibrary({pool,root,principal:'font-test-admin'});});
afterAll(async()=>{await db.close();await rm(root,{recursive:true,force:true});delete process.env.FONT_STORAGE_DIR;});
it('reviews every real face, requires exact visual approval, activates once and freezes members',async()=>{
 const f=await stageSet(pool,root,{files:['Sarabun-Regular.ttf','Sarabun-Bold.ttf'],weights:[400,700]});
 await expect(life.activate(f.id,m(0,{reviewId:f.id,manifestDigest:f.manifestDigest}))).rejects.toThrow();
 const q=await life.submitReview(f.id,m(0,{manifestDigest:f.manifestDigest}));expect(q.state).toBe('in_review');
 const run=await life.run(q.reviewId,m(q.revision,{manifestDigest:q.manifestDigest}));expect(run.report.ok,JSON.stringify(run)).toBe(true);expect(run.report.faces).toHaveLength(2);
 await expect(life.approve(q.reviewId,m(run.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:[]}))).rejects.toMatchObject({code:'FONT_REVIEW_STALE'});
 const approved=await life.approve(q.reviewId,m(run.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}));expect(approved.state).toBe('ready');
 const request=m(approved.revision,{reviewId:q.reviewId,manifestDigest:f.manifestDigest});const [a,b]=await Promise.all([life.activate(f.id,request),life.activate(f.id,request)]);expect(a).toEqual(b);expect(a.state).toBe('active');
 await expect(life.editRelease(f.id,{...f.candidate,expectedRevision:a.revision,requestId:'edit-active'})).rejects.toMatchObject({code:'FONT_STATE_CONFLICT'});
 await expect(pool.query('DELETE FROM font_faces WHERE release_id=$1',[f.id])).rejects.toThrow();
 if(process.env.FONT_PROOF_DIR)for(const [i,face] of run.report.faces.entries())await writeFile(join(process.env.FONT_PROOF_DIR,'review-'+i+'.pdf'),await life.artifact(q.reviewId,face.artifactHash));
},120000);
it('one failed face rejects the whole set and returns needs_changes',async()=>{
 const f=await stageSet(pool,root,{files:['Sarabun-Regular.ttf','Sarabun-Bold.ttf'],weights:[400,700]}),q=await life.submitReview(f.id,m(0,{manifestDigest:f.manifestDigest}));
 const asset=(await pool.query('SELECT a.* FROM font_assets a JOIN font_faces f ON f.asset_id=a.id WHERE f.release_id=$1 AND f.approved_weight=700',[f.id])).rows[0],key=join(root,'assets',asset.storage_key),bytes=await readFile(key);await writeFile(key,'corrupt');
 try{const run=await life.run(q.reviewId,m(q.revision,{manifestDigest:q.manifestDigest}));expect(run.report.ok).toBe(false);expect(run.state).toBe('needs_changes');await expect(life.approve(q.reviewId,m(run.revision,{manifestDigest:q.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}))).rejects.toMatchObject({code:'FONT_REVIEW_FAILED'});}finally{await writeFile(key,bytes);}
},120000);
it('withdraw invalidates stale reports, stale revisions and review/edit races cannot release old members',async()=>{
 const f=await stageSet(pool,root),q=await life.submitReview(f.id,m(0,{manifestDigest:f.manifestDigest})),run=await life.run(q.reviewId,m(q.revision,{manifestDigest:q.manifestDigest}));const w=await life.withdrawReview(f.id,m(run.revision,{reviewId:q.reviewId}));expect(w.state).toBe('preparing');
 await expect(life.approve(q.reviewId,m(w.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}))).rejects.toMatchObject({code:'FONT_REVIEW_STALE'});
 const edit=await life.editRelease(f.id,{...f.candidate,requestId:'edit-reopen',expectedRevision:w.revision,languageScope:['en']});expect(edit.manifestDigest).not.toBe(f.manifestDigest);expect(edit.revision).toBe(w.revision+1);
 await expect(life.submitReview(f.id,m(w.revision,{manifestDigest:edit.manifestDigest}))).rejects.toMatchObject({code:'STALE_CURRENT'});
 const attempts=await Promise.allSettled([life.submitReview(f.id,m(edit.revision,{manifestDigest:edit.manifestDigest})),life.editRelease(f.id,{...f.candidate,requestId:'racing-edit',expectedRevision:edit.revision})]);expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
},120000);
it('defaults require active same-family CAS; retirement replaces or clears atomically; reactivation keeps old references eligible',async()=>{
 const a=await releaseSet(pool,root,await stageSet(pool,root)),b=await releaseSet(pool,root,await stageSet(pool,root,{familyId:a.familyId,version:2,files:['Sarabun-Regular.ttf','Sarabun-Bold.ttf'],weights:[400,700]}));
 await expect(life.setDefault(a.familyId,m(0,{releaseId:(await stageSet(pool,root)).id}))).rejects.toThrow();
 const set=await life.setDefault(a.familyId,m(0,{releaseId:a.id}));await expect(life.setDefault(a.familyId,m(0,{releaseId:b.id}))).rejects.toMatchObject({code:'STALE_CURRENT'});
 const api=createAuthoring(pool,'retained-owner',{maxOutstanding:10,imagesEnabled:false}),draft=ok(await api.create({docKey:'lifecycle-retained',name:'Retained',idempotencyKey:'create'})),definition=JSON.parse(await readFile('examples/area-document-template.json','utf8'));Object.assign(definition,{schemaVersion:2,templateId:draft.templateId,docKey:draft.docKey});for(const [k,s] of Object.entries(definition.styles))definition.styles[k]={font:{kind:'library',releaseId:a.id,weight:400,style:'normal'},fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};
 expect(ok(await api.save(draft.templateId,{definition,expectedRevision:0,idempotencyKey:'save'})).fontReadiness.status).toBe('ready');
 await expect(life.retire(a.id,m(a.revision,{expectedFamilyRevision:set.revision}))).rejects.toMatchObject({code:'FONT_DEFAULT_DECISION_REQUIRED'});
 expect((await lib.getRelease(a.id)).state).toBe('active');
 const retired=await life.retire(a.id,m(a.revision,{expectedFamilyRevision:set.revision,replacementDefaultReleaseId:b.id}));expect(retired.state).toBe('retired');expect((await pool.query("SELECT summary FROM font_audit_events WHERE release_id=$1 AND action='retire'",[a.id])).rows[0].summary.defaultChange).toMatchObject({previousReleaseId:a.id,releaseId:b.id,familyRevision:2});expect((await pool.query('SELECT default_release_id FROM font_families WHERE id=$1',[a.familyId])).rows[0].default_release_id).toBe(b.id);
 expect(ok(await api.get(draft.templateId)).fontReadiness.status).toBe('ready');expect(ok(await api.cloneDraft(draft.templateId,{sourceRevision:1,idempotencyKey:'clone',name:'Copy',docKey:'lifecycle-copy'})).fontReadiness.status).toBe('ready');
 const request=JSON.parse(await readFile('examples/area-document-request.json','utf8'));request.docKey=draft.docKey;ok(await api.preview(draft.templateId,{expectedRevision:1,idempotencyKey:'preview-retired',sampleRequest:request}));
 const q=await life.reactivationReview(a.id,m(retired.revision,{manifestDigest:a.manifestDigest}));expect(q.state).toBe('retired');expect(ok(await api.get(draft.templateId)).fontReadiness.status).toBe('ready');
 const run=await life.run(q.reviewId,m(q.revision,{manifestDigest:q.manifestDigest})),approved=await life.approve(q.reviewId,m(run.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}));expect(approved.state).toBe('retired');expect((await life.activate(a.id,m(approved.revision,{reviewId:q.reviewId,manifestDigest:a.manifestDigest}))).state).toBe('active');expect((await lib.getRelease(a.id)).manifestDigest).toBe(a.manifestDigest);
 await life.retire(b.id,m(b.revision,{expectedFamilyRevision:set.revision+1,clearDefault:true}));expect((await pool.query('SELECT default_release_id FROM font_families WHERE id=$1',[a.familyId])).rows[0].default_release_id).toBeNull();
},180000);
it('deletion guards retain shared files, review history and immutable audit',async()=>{const f=await stageSet(pool,root);const deleted=await life.deleteRelease(f.id,m(0));expect(deleted.deleted).toBe(true);await expect(lib.getRelease(f.id)).rejects.toMatchObject({code:'FONT_RELEASE_NOT_FOUND'});const other=await stageSet(pool,root,{familyId:f.familyId,version:2});expect(other.faces[0].assetId).toBe(f.faces[0].assetId);const q=await life.submitReview(other.id,m(0,{manifestDigest:other.manifestDigest}));const w=await life.withdrawReview(other.id,m(q.revision,{reviewId:q.reviewId}));await expect(life.deleteRelease(other.id,m(w.revision))).rejects.toMatchObject({code:'FONT_STATE_CONFLICT'});expect((await pool.query('SELECT count(*) FROM font_audit_events WHERE release_id=$1',[f.id])).rows[0].count).toBe('2');});
it('weight conclusions preserve all three values and original provenance; edited results need a new review',async()=>{
 const f=await stageSet(pool,root,{weights:[500]}),binding={...f.candidate.faceBindings[0],approvedWeight:400};
 const edited=await life.editRelease(f.id,{...f.candidate,requestId:'weight-unresolved',expectedRevision:0,faceBindings:[binding]});expect(edited.issues.some(i=>i.code==='FONT_WEIGHT_REVIEW_REQUIRED')).toBe(true);
 await expect(life.submitReview(f.id,m(edited.revision,{manifestDigest:edited.manifestDigest}))).rejects.toMatchObject({code:'FONT_REVIEW_FAILED'});
 const resolved=await life.editRelease(f.id,{...f.candidate,requestId:'weight-resolved',expectedRevision:edited.revision,faceBindings:[{...binding,conflictResolution:{reason:'Explicit provider metadata discrepancy reviewed',sourceWeight:500,approvedWeight:400}}]});expect(resolved.issues).toEqual([]);expect(resolved.manifestDigest).not.toBe(edited.manifestDigest);
 const row=(await pool.query('SELECT f.raw_weight,f.source_weight,f.approved_weight,f.conflict_resolution,e.metadata FROM font_faces f JOIN font_source_evidence e ON e.id=f.source_evidence_id WHERE f.release_id=$1',[f.id])).rows[0];expect(row).toMatchObject({raw_weight:400,source_weight:500,approved_weight:400,conflict_resolution:{reviewer:'font-test-admin'},metadata:{sourceWeight:500}});
 const released=await releaseSet(pool,root,resolved);expect(released.state).toBe('active');
},120000);
it('activation refuses changed files after review approval without advancing release/default/audit',async()=>{
 const f=await stageSet(pool,root),q=await life.submitReview(f.id,m(0,{manifestDigest:f.manifestDigest})),run=await life.run(q.reviewId,m(q.revision,{manifestDigest:q.manifestDigest})),a=await life.approve(q.reviewId,m(run.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}));
 const asset=(await pool.query('SELECT a.* FROM font_assets a JOIN font_faces f ON f.asset_id=a.id WHERE f.release_id=$1',[f.id])).rows[0],path=join(root,'assets',asset.storage_key),bytes=await readFile(path);await writeFile(path,'changed');
 try{await expect(life.activate(f.id,m(a.revision,{reviewId:q.reviewId,manifestDigest:f.manifestDigest}))).rejects.toMatchObject({code:'FONT_ASSET_UNAVAILABLE'});expect((await lib.getRelease(f.id)).state).toBe('ready');expect((await pool.query("SELECT count(*) FROM font_audit_events WHERE release_id=$1 AND action='activate'",[f.id])).rows[0].count).toBe('0');}finally{await writeFile(path,bytes);}
},120000);
