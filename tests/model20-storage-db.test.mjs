import {beforeAll,afterAll,it,expect} from 'vitest';import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';import {publishCurrent} from '../dist/templates/publish.js';import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
import {assemble} from '../dist/templates/assembly.js';import {reconcileDefinition} from '../dist/authoring/adapter.js';import {readReferences} from '../dist/fonts/retention.js';
import {ok,fixture,prepared,insertJob} from './helpers/model20-db.mjs';
const db=isolatedDatabase();beforeAll(async()=>{await db.setup();ok(await migrate(db.pool))});afterAll(()=>db.close());
it.each([18,19,20])('registers model%s atomically, retains font snapshot provenance and repeats idempotently',async model=>{
 const {t}=fixture(model,'model'+model+'-register'),[a,b]=await Promise.all([registerTemplate(db.pool,JSON.stringify(t)),registerTemplate(db.pool,JSON.stringify(t))]);const x=ok(a),y=ok(b);expect(x.versionId).toBe(y.versionId);expect([x.created,y.created].sort()).toEqual([false,true]);
 const loaded=ok(await loadTemplate(db.pool,t.docKey,1));expect(loaded.template.definition).toEqual(t);
 const refs=await readReferences(db.pool,t.templateId,0,x.versionId);expect(refs.definitionFingerprint).toBe(x.fingerprint);expect(refs.legacyBindings).toHaveLength(4);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM template_versions WHERE template_id=$1',[t.templateId])).rows[0].n).toBe(1);
});
it('retains model20 definition ownership through saves, publication retries and concurrent revisions',async()=>{
 const {t}=fixture(20,'model20-save'),r=ok(await importCurrent(db.pool,JSON.stringify(t))),pub=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'}));
 expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'})).versionId).toBe(pub.versionId);
 const old=ok(await loadTemplate(db.pool,t.docKey,1)),next=structuredClone(t);next.examples=[];next.sections.reverse();next.sections[1].sectionKey='Renamed';
 const record=reconcileDefinition(next,r),results=await Promise.all([saveCurrent(db.pool,structuredClone(record),r.revision),saveCurrent(db.pool,structuredClone(record),r.revision)]);expect(results.filter(x=>x.ok)).toHaveLength(1);expect(results.find(x=>!x.ok).issues[0].code).toBe('STALE_CURRENT');
 const current=ok(await loadCurrent(db.pool,t.templateId));expect(current.sections.map(s=>s.id).sort()).toEqual(r.sections.map(s=>s.id).sort());expect(assemble(current,1)).toEqual(next);expect((await db.pool.query('SELECT * FROM section_instance_history WHERE template_id=$1',[t.templateId])).rows).toEqual([]);
 const second=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'second'}));expect(second.version).toBe(2);expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(old.template);
 await expect(db.pool.query("UPDATE section_versions SET key='forged' WHERE template_version_id=$1",[pub.versionId])).rejects.toMatchObject({code:'55000'});
 for(const scope of ['section','header','footer']){expect((await db.pool.query('SELECT count(*)::int AS n FROM variable_schemas WHERE template_id=$1 AND scope=$2',[t.templateId,scope])).rows[0].n).toBeGreaterThan(0);await expect(db.pool.query('UPDATE variable_schemas SET section_id=NULL WHERE template_id=$1 AND scope=$2',[t.templateId,scope])).rejects.toMatchObject({code:'23514'});}
 await expect(db.pool.query("INSERT INTO variable_schema_versions(id,template_version_id,scope) VALUES($1,$2,'section')",[randomUUID(),pub.versionId])).rejects.toMatchObject({code:'23514'});
});
it('accepts exact model20 prepared-schema3 legacy/preview pins and rejects tampering',async()=>{
 const {t,request}=fixture(20,'model20-pins'),v=await db.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$1,$1) RETURNING id',[t.templateId]);expect(v.rowCount).toBe(1);
 const id=randomUUID(),p=prepared(t,request);await db.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[id,t.templateId,t,p.template.fingerprint]);
 // Explicit synthetic pin rows isolate trigger behavior; this is not registration proof.
 await db.pool.query("INSERT INTO authoring_templates(template_id,principal) VALUES($1,'owner')",[t.templateId]);
 const job=await insertJob(db.pool,{versionId:id,t,request}),preview=await insertJob(db.pool,{preview:true,t,request});
 await expect(db.pool.query("UPDATE generation_jobs SET prepared_input=jsonb_set(prepared_input,'{template,nodeModelVersion}','19') WHERE id=$1",[job])).rejects.toMatchObject({code:'55000'});
 await expect(db.pool.query('UPDATE generation_jobs SET preview_revision=2 WHERE id=$1',[preview])).rejects.toMatchObject({code:'55000'});
 for(const input of [{...p,schemaVersion:2},{...p,template:{...p.template,nodeModelVersion:19}},{...p,warnings:[{code:'FAKE'}]}]){await expect(insertJob(db.pool,{versionId:id,t,request,p:input})).rejects.toMatchObject({code:'23514'});await expect(insertJob(db.pool,{preview:true,t,request,p:input})).rejects.toMatchObject({code:'23514'});}
 await expect(insertJob(db.pool,{versionId:id,t,request,format:'docx'})).rejects.toMatchObject({code:'23514'});
});
it('rolls back current graph, snapshots, receipts and font reference writes on injected failure',async()=>{
 const {t}=fixture(20,'model20-atomic'),r=ok(await importCurrent(db.pool,JSON.stringify(t)));const before=await loadCurrent(db.pool,t.templateId),refs=(await db.pool.query('SELECT count(*)::int AS n FROM font_reference_sets WHERE template_id=$1',[t.templateId])).rows[0].n;
 await db.pool.query("CREATE FUNCTION m20_fail_refs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.template_id IN ('model20-atomic','model20-reg-atomic') THEN RAISE EXCEPTION 'lab injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER m20_fail_refs BEFORE INSERT ON font_reference_sets FOR EACH ROW EXECUTE FUNCTION m20_fail_refs()");
 const changed=structuredClone(r);changed.payload.name='changed';expect((await saveCurrent(db.pool,changed,r.revision)).ok).toBe(false);expect(await loadCurrent(db.pool,t.templateId)).toEqual(before);
 expect((await publishCurrent(db.pool,{templateId:t.templateId,requestId:'fail'})).ok).toBe(false);
 for(const table of ['template_versions','publication_receipts'])expect((await db.pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE template_id=$1',[t.templateId])).rows[0].n).toBe(0);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM font_reference_sets WHERE template_id=$1',[t.templateId])).rows[0].n).toBe(refs);
 const {t:failedRegistration}=fixture(20,'model20-reg-atomic');expect((await registerTemplate(db.pool,JSON.stringify(failedRegistration))).ok).toBe(false);expect((await db.pool.query('SELECT * FROM templates WHERE id=$1',[failedRegistration.templateId])).rows).toEqual([]);
 await db.pool.query('DROP TRIGGER m20_fail_refs ON font_reference_sets; DROP FUNCTION m20_fail_refs()');expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'fail'})).version).toBe(1);expect(ok(await registerTemplate(db.pool,JSON.stringify(failedRegistration))).created).toBe(true);
});
it.each([[1,'pdf'],[2,'pdf'],[2,'docx']])('preserves the task-job v%s pin and immutable %s output format branch',async(normalization,format)=>{
 const {t}=fixture(18,'task-pin-'+normalization+'-'+format),v=ok(await registerTemplate(db.pool,JSON.stringify(t))),id=randomUUID(),fid=randomUUID(),digest='a'.repeat(64),core={version:'pinned',sha256:'b'.repeat(64)};
 await db.pool.query("INSERT INTO tasks(id,owner_key,created_by_principal,template_version_id,template_pin,resource_policy,output_format,normalization_version,status) VALUES($1,'owner','creator',$2,$3,'{}',$4,$5,'receiving')",[id,v.versionId,{docKey:t.docKey,version:1,fingerprint:v.fingerprint},format,normalization]);
 await db.pool.query("INSERT INTO task_files(id,task_id,role,logical_path,part_order,media_type,state,checksum,storage_key) VALUES($1,$2,'normalized','normalized-input-v2',0,'application/json','received',$3,$4)",[fid,id,digest,id+'/normalized/'+fid+'.bin']);
 await db.pool.query("UPDATE tasks SET status='validating',sealed_at=now(),file_name='document',input_digest=$2,normalized_at=now(),normalized_digest=$2,normalized_file_id=$3,normalization_summary=$4 WHERE id=$1",[id,digest,fid,{normalizationVersion:normalization,outputFormat:format,coreVersion:core.version,coreSha256:core.sha256}]);
 const original={contract:'flowdoc-task-request/'+normalization,taskId:id,inputDigest:digest,...(normalization===2?{outputFormat:format}:{})},p={contract:'flowdoc-task-job/'+normalization,taskId:id,normalizedFileId:fid,normalizedDigest:digest,core,...(normalization===2?{outputFormat:format}:{})},job=randomUUID();
 await db.pool.query('INSERT INTO generation_jobs(id,task_id,template_version_id,original_input,prepared_input,output_format) VALUES($1,$2,$3,$4,$5,$6)',[job,id,v.versionId,original,p,format]);
 await expect(db.pool.query('UPDATE generation_jobs SET output_format=$2 WHERE id=$1',[job,format==='pdf'?'docx':'pdf'])).rejects.toMatchObject({code:'55000'});
 await expect(db.pool.query('INSERT INTO generation_jobs(id,task_id,template_version_id,original_input,prepared_input,output_format) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,v.versionId,original,{...p,normalizedDigest:'c'.repeat(64)},format])).rejects.toMatchObject({code:'23514'});
});
