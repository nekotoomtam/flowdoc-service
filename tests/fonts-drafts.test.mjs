import {beforeAll,afterAll,it,expect} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createAuthoring} from '../dist/authoring/service.js';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {stageFont} from './fontFixture.mjs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
const db=isolatedDatabase(),pool=db.pool,ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};let root,api,other,seed,sample;
beforeAll(async()=>{await db.setup();ok(await migrate(pool));root=await mkdtemp(join(tmpdir(),'font-drafts-'));process.env.FONT_STORAGE_DIR=root;api=createAuthoring(pool,'owner',{maxOutstanding:10,imagesEnabled:false});other=createAuthoring(pool,'other',{maxOutstanding:10,imagesEnabled:false});seed=JSON.parse(await readFile('examples/area-document-template.json','utf8'));sample=JSON.parse(await readFile('examples/area-document-request.json','utf8'));});
afterAll(async()=>{delete process.env.FONT_STORAGE_DIR;await db.close();await rm(root,{recursive:true,force:true});});
async function draft(font={kind:'unselected'}){const id=ok(await api.create({name:'Fonts',docKey:'fonts-'+randomUUID(),idempotencyKey:randomUUID()}));const definition={...structuredClone(seed),templateId:id.templateId,docKey:id.docKey,schemaVersion:2};for(const [k,s] of Object.entries(definition.styles))definition.styles[k]={font,fontSize:s.fontSize,lineHeightPt:s.lineHeightPt};return {id,definition};}
it('saves/readbacks unresolved drafts, rejects malformed/foreign/stale atomically and keeps original receipt',async()=>{
 const {id,definition}=await draft();const input={definition,expectedRevision:0,idempotencyKey:'first'};
 const saved=ok(await api.save(id.templateId,input));expect(saved).toMatchObject({revision:1,fontReadiness:{status:'blocked',checkedScope:'styles'}});
 expect(ok(await api.get(id.templateId)).definition).toEqual(definition);
 const counts=async()=>Promise.all(['template_current','font_reference_sets','authoring_audit','authoring_receipts'].map(async t=>(await pool.query('SELECT count(*) FROM '+t)).rows));const before=await counts();
 const bad=structuredClone(definition);Object.values(bad.styles)[0].font={kind:'library',releaseId:randomUUID(),weight:'400',style:'normal'};
 expect(await api.save(id.templateId,{definition:bad,expectedRevision:1,idempotencyKey:'bad'})).toMatchObject({ok:false,issues:[{code:'INVALID_FONT_SELECTION'}]});
 expect(await other.save(id.templateId,{definition,expectedRevision:1,idempotencyKey:'foreign'})).toMatchObject({ok:false,issues:[{code:'TEMPLATE_NOT_FOUND'}]});
 expect(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'stale'})).toMatchObject({ok:false,issues:[{code:'STALE_CURRENT'}]});expect(await counts()).toEqual(before);
 expect(ok(await api.save(id.templateId,input))).toEqual(saved);
 const preview=await api.preview(id.templateId,{expectedRevision:1,sampleRequest:{...sample,docKey:id.docKey},idempotencyKey:'blocked'});expect(preview).toMatchObject({ok:false,issues:[{code:'FONT_NOT_SELECTED'}]});
 expect((await pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count).toBe('0');
});
it('grants only active exact tuples; preserves retired tuples through rename/clone and removes them after omission',async()=>{
 const f=await stageFont(pool,root);await pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[f.id]);
 const {id,definition}=await draft(f.fontSelection);expect(ok(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'active'})).fontReadiness.status).toBe('ready');
 await pool.query("UPDATE font_releases SET state='retired' WHERE id=$1",[f.id]);
 const inherited=ok(await api.cloneDraft(id.templateId,{sourceRevision:1,name:'Copy',docKey:'copy-'+randomUUID(),idempotencyKey:'clone'}));expect(inherited.fontReadiness.status).toBe('ready');
 expect(await other.cloneDraft(id.templateId,{sourceRevision:1,name:'Bad',docKey:'bad',idempotencyKey:'bad'})).toMatchObject({ok:false,issues:[{code:'TEMPLATE_NOT_FOUND'}]});
 const rename=structuredClone(definition);rename.styles.extra=structuredClone(Object.values(rename.styles)[0]);expect(ok(await api.save(id.templateId,{definition:rename,expectedRevision:1,idempotencyKey:'rename'})).fontReadiness.status).toBe('ready');
 const omitted=structuredClone(definition);for(const s of Object.values(omitted.styles))s.font={kind:'unselected'};ok(await api.save(id.templateId,{definition:omitted,expectedRevision:2,idempotencyKey:'remove'}));
 expect(ok(await api.save(id.templateId,{definition,expectedRevision:3,idempotencyKey:'restore-json'})).fontReadiness).toMatchObject({status:'blocked',issues:[{code:'FONT_REFERENCE_NOT_RETAINED'}]});
 expect(ok(await api.cloneDraft(id.templateId,{sourceRevision:1,name:'Copy',docKey:inherited.docKey,idempotencyKey:'clone'})).templateId).toBe(inherited.templateId);
});
it('saves unknown, preparing and missing faces with issues; JSON cannot confer retained rights',async()=>{
 const f=await stageFont(pool,root);
 for(const [selection,code] of [[{...f.fontSelection,releaseId:randomUUID()},'FONT_RELEASE_NOT_FOUND'],[f.fontSelection,'FONT_RELEASE_NOT_ACTIVE']]){
  const {id,definition}=await draft(selection);expect(ok(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'save'})).fontReadiness).toMatchObject({status:'blocked',issues:[{code}]});
 }
 await pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[f.id]);
 const {id,definition}=await draft({...f.fontSelection,style:'italic'});expect(ok(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'save'})).fontReadiness).toMatchObject({status:'blocked',issues:[{code:'FONT_FACE_UNAVAILABLE'}]});
 Object.values(definition.styles)[0].font.retained=true;
 expect(await api.save(id.templateId,{definition,expectedRevision:1,idempotencyKey:'injected'})).toMatchObject({ok:false,issues:[{code:'INVALID_FONT_SELECTION'}]});
});
it('adds readiness without dropping existing Core data warnings',async()=>{
 const {id,definition}=await draft(),input={...structuredClone(sample),docKey:id.docKey};input.data.extra='unknown';
 const v=ok(validateTemplate(definition)),p=ok(prepareGeneration(v,input)),d=composeDocument(v,p);expect(d.ok).toBe(true);expect(p.warnings.length).toBeGreaterThan(0);
 const result=await api.validate({definition,sampleRequest:input});expect(result.ok).toBe(true);expect(result.warnings).toEqual([...p.warnings,...d.warnings]);
});
it('saves a missing asset as incomplete and blocks previews with missing provenance',async()=>{
 const f=await stageFont(pool,root);await pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[f.id]);
 const {id,definition}=await draft(f.fontSelection);await rm(join(root,'assets',f.sha256+'.bin'));
 try{expect(ok(await api.save(id.templateId,{definition,expectedRevision:0,idempotencyKey:'missing'}))).toMatchObject({revision:1,fontReadiness:{status:'incomplete',issues:[{code:'FONT_ASSET_UNAVAILABLE'}]}});}finally{await writeFile(join(root,'assets',f.sha256+'.bin'),f.font);}
 const empty=await draft();ok(await api.save(empty.id.templateId,{definition:empty.definition,expectedRevision:0,idempotencyKey:'saved'}));
 await pool.query('ALTER TABLE font_reference_sets DISABLE TRIGGER font_refs_immutable');
 try{await pool.query('DELETE FROM font_reference_sets WHERE template_id=$1',[empty.id.templateId]);}finally{await pool.query('ALTER TABLE font_reference_sets ENABLE TRIGGER font_refs_immutable');}
 expect(ok(await api.get(empty.id.templateId)).fontReadiness.status).toBe('incomplete');
 expect(await api.preview(empty.id.templateId,{expectedRevision:1,sampleRequest:{...sample,docKey:empty.id.docKey},idempotencyKey:'restored-without-provenance'})).toMatchObject({ok:false,issues:[{code:'FONT_CHECK_UNAVAILABLE'}]});
});
