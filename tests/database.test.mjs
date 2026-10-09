import {beforeAll,afterAll,it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareGeneration} from '@flowdoc/core';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL must name an isolated test database');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const original=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
const make=(key,version=1)=>({...structuredClone(original),templateId:'tpl-'+key,docKey:key,version});
const register=t=>registerTemplate(pool,JSON.stringify(t));
const unwrap=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{unwrap(await migrate(pool));});
afterAll(()=>pool.end());
it('replays checksummed migrations without duplicate domain tables',async()=>{expect(unwrap(await migrate(pool)).applied).toEqual([]);const r=await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");expect(r.rows.map(r=>r.tablename).sort()).toEqual(['document_outputs','formats','format_versions','generation_jobs','job_processing','publication_receipts','schema_migrations','template_current','template_snapshots','template_versions','templates','upload_sessions','upload_items','upload_job_claims','variable_schema_versions','variable_schemas','variable_types','variable_versions','variables'].sort());});
it('registers raw JSON, loads exact/latest and preserves previous definitions',async()=>{
 const t=make('versions');const v1=unwrap(await register(t));expect(v1.created).toBe(true);expect(unwrap(await register(t))).toMatchObject({created:false,versionId:v1.versionId});
 const second={...t,version:2,name:'New revision'};unwrap(await register(second));
 const latest=unwrap(await loadTemplate(pool,t.docKey));expect(latest.template.definition.version).toBe(2);const old=unwrap(await loadTemplate(pool,t.docKey,1));expect(old.versionId).toBe(v1.versionId);expect(old.template.definition.name).toBe(t.name);
 expect(await register({...t,name:'overwrite'})).toMatchObject({ok:false,issues:[{code:'TEMPLATE_VERSION_CONFLICT'}]});
 expect(await loadTemplate(pool,'missing')).toMatchObject({ok:false,issues:[{code:'TEMPLATE_NOT_FOUND'}]});expect(await loadTemplate(pool,t.docKey,99)).toMatchObject({ok:false,issues:[{code:'VERSION_NOT_FOUND'}]});
});
it('rejects raw duplicate keys, invalid definitions and invalid examples before writes',async()=>{
 const t=make('invalid');const raw=JSON.stringify(t);expect(await registerTemplate(pool,raw.slice(0,-1)+',"docKey":"overwritten"}')).toMatchObject({ok:false,issues:[{code:'INVALID_TEMPLATE'}]});
 t.examples=[{name:'bad',request:{docKey:t.docKey,version:1,data:{},content:[]}}];expect((await register(t)).ok).toBe(false);expect((await pool.query('SELECT id FROM templates WHERE doc_key=$1',[t.docKey])).rowCount).toBe(0);
});
it('rejects identity collisions without creating orphan templates',async()=>{
 const t=make('identity');unwrap(await register(t));expect(await register({...t,templateId:'other-id'})).toMatchObject({ok:false,issues:[{code:'TEMPLATE_IDENTITY_CONFLICT'}]});expect(await register({...t,docKey:'different-key'})).toMatchObject({ok:false,issues:[{code:'TEMPLATE_IDENTITY_CONFLICT'}]});expect((await pool.query('SELECT id FROM templates WHERE id=$1',['other-id'])).rowCount).toBe(0);
});
it('serializes concurrent same-version registrations and detects different content',async()=>{
 const t=make('concurrent');const results=await Promise.all(Array.from({length:8},()=>register(t)));expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&r.value.created)).toHaveLength(1);
 const u=make('collision');const pair=await Promise.all([register({...u,name:'A'}),register({...u,name:'B'})]);expect(pair.filter(r=>r.ok)).toHaveLength(1);expect(pair.find(r=>!r.ok)).toMatchObject({issues:[{code:'TEMPLATE_VERSION_CONFLICT'}]});
 const v=make('parallel-versions');expect((await Promise.all([register(v),register({...v,version:2})])).every(r=>r.ok)).toBe(true);expect(unwrap(await loadTemplate(pool,v.docKey)).template.definition.version).toBe(2);
});
it('rolls back the parent insertion when version storage fails',async()=>{
 await pool.query("ALTER TABLE template_versions ADD CONSTRAINT fixture_reject CHECK (definition_json->>'docKey' <> 'rollback')");
 try{expect(await register(make('rollback'))).toMatchObject({ok:false,issues:[{code:'STORAGE_FAILED'}]});expect((await pool.query("SELECT id FROM templates WHERE doc_key='rollback'")).rowCount).toBe(0);}finally{await pool.query('ALTER TABLE template_versions DROP CONSTRAINT fixture_reject');}
});
it('DB enforces immutable versions, stable identity, FK, output uniqueness and job pin',async()=>{
 const t=make('pinned');const reg=unwrap(await register(t)),selected=unwrap(await loadTemplate(pool,t.docKey));
 const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));input.docKey=t.docKey;delete input.version;
 const p=unwrap(prepareGeneration(selected.template,input)),job=randomUUID();
 await pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES($1,$2,$3,$4,$5,$6)',[job,reg.versionId,JSON.stringify(input),JSON.stringify(p),JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices)]);
 unwrap(await register({...t,version:2}));expect((await pool.query('SELECT template_version_id FROM generation_jobs WHERE id=$1',[job])).rows[0].template_version_id).toBe(reg.versionId);
 await expect(pool.query('UPDATE template_versions SET definition_json=definition_json WHERE id=$1',[reg.versionId])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query('DELETE FROM template_versions WHERE id=$1',[reg.versionId])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query("UPDATE templates SET doc_key='changed' WHERE id=$1",[t.templateId])).rejects.toMatchObject({code:'55000'});
 const newVersion=unwrap(await loadTemplate(pool,t.docKey)).versionId;
 await expect(pool.query('UPDATE generation_jobs SET template_version_id=$1 WHERE id=$2',[newVersion,job])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query("UPDATE generation_jobs SET original_input='{}' WHERE id=$1",[job])).rejects.toMatchObject({code:'55000'});
 await expect(pool.query('INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES($1,$2,$3,$4,$5)',[randomUUID(),randomUUID(),'x.pdf','application/pdf',1])).rejects.toMatchObject({code:'23503'});
 await pool.query('INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES($1,$2,$3,$4,$5)',[randomUUID(),job,'sample.pdf','application/pdf',10]);
 await expect(pool.query('INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES($1,$2,$3,$4,$5)',[randomUUID(),job,'duplicate.pdf','application/pdf',10])).rejects.toMatchObject({code:'23505'});
 const bad=structuredClone(p);bad.template.version=2;
 await expect(pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input) VALUES($1,$2,$3,$4)',[randomUUID(),reg.versionId,JSON.stringify(input),JSON.stringify(bad)])).rejects.toMatchObject({code:'23514'});
});
it('rejects changed migration checksums without changing the schema',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'flowdoc-migration-test-'));writeFileSync(join(dir,'001_initial.sql'),readFileSync('migrations/001_initial.sql','utf8')+'\n-- changed');
 expect(await migrate(pool,dir)).toMatchObject({ok:false,issues:[{code:'MIGRATION_MISMATCH'}]});expect(unwrap(await migrate(pool)).applied).toEqual([]);
});
