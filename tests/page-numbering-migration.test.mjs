import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
it('upgrades populated011 preserving unsupported history before accepting Area18',async()=>{
 const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};await db.setup();try{
 await db.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of readdirSync('migrations').filter(n=>/^(00[1-9]|01[01])_/.test(n)).sort()){const sql=readFileSync('migrations/'+name,'utf8');await db.pool.query(sql);await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
 const t=JSON.parse(readFileSync('tests/fixtures/model4-template.json','utf8')),versionId=randomUUID(),fingerprint='a'.repeat(64);
 await db.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[t.templateId,t.docKey,t.name]);await db.pool.query('INSERT INTO template_current(template_id,payload) VALUES($1,$2)',[t.templateId,JSON.stringify(t)]);await db.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[versionId,t.templateId,JSON.stringify(t),fingerprint]);await db.pool.query('INSERT INTO template_snapshots(version_id,payload) VALUES($1,$2)',[versionId,JSON.stringify(t)]);
 const before=(await db.pool.query('SELECT * FROM template_current')).rows,versions=(await db.pool.query('SELECT * FROM template_versions')).rows;
 expect(ok(await migrate(db.pool)).applied).toEqual(['012_page_numbering.sql','013_row_groups.sql','014_area_document.sql','015_authoring_previews.sql','016_font_library_staging.sql','017_font_references_jobs.sql','018_font_lifecycle.sql','019_font_height_profiles.sql','020_font_height_proposals.sql','021_section_instances.sql']);expect((await db.pool.query('SELECT * FROM template_current')).rows).toEqual(before);expect((await db.pool.query('SELECT * FROM template_versions')).rows).toEqual(versions);expect((await loadTemplate(db.pool,t.docKey,1)).ok).toBe(false);expect((await loadCurrent(db.pool,t.templateId)).ok).toBe(false);
 const n=JSON.parse(readFileSync('examples/page-numbering-template.json','utf8'));ok(await importCurrent(db.pool,JSON.stringify(n)));ok(await publishCurrent(db.pool,{templateId:n.templateId,requestId:'new'}));expect(ok(await loadTemplate(db.pool,n.docKey,1)).template.definition.nodeModelVersion).toBe(18);
 }finally{await db.close();}
});
