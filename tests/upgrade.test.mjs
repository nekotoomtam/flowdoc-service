import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync,mkdtempSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {migrate} from '../dist/db/migrate.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {loadCurrent} from '../dist/templates/current.js';
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
it('upgrades populated R3 without changing IDs, fingerprint or pinned inputs',async()=>{
 const admin=new Pool({connectionString:process.env.DATABASE_URL});const schema='upgrade_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const p=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema});
 try{const dir=mkdtempSync(join(tmpdir(),'flowdoc-r3-'));copyFileSync('migrations/001_initial.sql',join(dir,'001_initial.sql'));ok(await migrate(p,dir));
 const t=JSON.parse(readFileSync('examples/srs-template.json','utf8')),v=ok(validateTemplate(t)),id=randomUUID(),job=randomUUID();
 await p.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[t.templateId,t.docKey,t.name]);await p.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[id,t.templateId,JSON.stringify(t),v.fingerprint]);
 const input=JSON.parse(readFileSync('examples/srs-request.json','utf8')),prepared=ok(prepareGeneration(v,input));
 await p.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES($1,$2,$3,$4,$5,$6)',[job,id,JSON.stringify(input),JSON.stringify(prepared),JSON.stringify(prepared.warnings),JSON.stringify(prepared.skippedContentIndices)]);
 const t2={...t,version:2,name:'Second revision'},v2=ok(validateTemplate(t2)),id2=randomUUID();
 await p.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,2,$3,$4)',[id2,t.templateId,JSON.stringify(t2),v2.fingerprint]);
 await p.query('INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES($1,$2,$3,$4,10)',[randomUUID(),job,'preserved.pdf','application/pdf']);
 ok(await migrate(p));expect(ok(await migrate(p)).applied).toEqual([]);expect((await p.query('SELECT source_variable_id FROM variable_versions')).rows.every(r=>r.source_variable_id===null)).toBe(true);const loaded=ok(await loadTemplate(p,t.docKey,1));expect(loaded.versionId).toBe(id);expect(loaded.template).toEqual(v);expect(ok(await loadCurrent(p,t.templateId)).revision).toBe(1);expect(ok(await loadCurrent(p,t.templateId)).payload.name).toBe('Second revision');expect(ok(await loadTemplate(p,t.docKey,2)).versionId).toBe(id2);expect((await p.query('SELECT path FROM document_outputs WHERE job_id=$1',[job])).rows[0].path).toBe('preserved.pdf');
 expect((await p.query('SELECT template_version_id,prepared_input FROM generation_jobs WHERE id=$1',[job])).rows[0]).toEqual({template_version_id:id,prepared_input:prepared});
 }finally{await p.end();await admin.end();}
});
it('rolls back migration 002 when historical validation fails',async()=>{
 const admin=new Pool({connectionString:process.env.DATABASE_URL}),schema='badupgrade_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const p=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema});
 try{const dir=mkdtempSync(join(tmpdir(),'flowdoc-r3-bad-'));copyFileSync('migrations/001_initial.sql',join(dir,'001_initial.sql'));ok(await migrate(p,dir));const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
 await p.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[t.templateId,t.docKey,t.name]);await p.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[randomUUID(),t.templateId,JSON.stringify(t),'0'.repeat(64)]);
 expect((await migrate(p)).ok).toBe(false);expect((await p.query("SELECT to_regclass('variable_types') AS value")).rows[0].value).toBe(null);expect((await p.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(1);
 }finally{await p.end();await admin.end();}
});
