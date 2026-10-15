import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
it('upgrades populated012, preserves locked versions and remaps every nested parent on publication',async()=>{
 const db=isolatedDatabase();await db.setup();try{
  await db.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of readdirSync('migrations').filter(n=>/^(00[1-9]|01[012])_/.test(n)).sort()){const sql=readFileSync('migrations/'+name,'utf8');await db.pool.query(sql);await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
  const old=JSON.parse(readFileSync('tests/fixtures/model4-template.json','utf8')),versionId=randomUUID();
  await db.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[old.templateId,old.docKey,old.name]);await db.pool.query('INSERT INTO template_current(template_id,payload) VALUES($1,$2)',[old.templateId,JSON.stringify(old)]);await db.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[versionId,old.templateId,JSON.stringify(old),'a'.repeat(64)]);await db.pool.query('INSERT INTO template_snapshots(version_id,payload) VALUES($1,$2)',[versionId,JSON.stringify(old)]);
  const before=(await db.pool.query('SELECT * FROM template_current')).rows,locked=(await db.pool.query('SELECT * FROM template_versions')).rows;
  expect(ok(await migrate(db.pool)).applied).toEqual(['013_row_groups.sql','014_area_document.sql','015_authoring_previews.sql']);expect(ok(await migrate(db.pool)).applied).toEqual([]);
  expect((await db.pool.query('SELECT * FROM template_current')).rows).toEqual(before);expect((await db.pool.query('SELECT * FROM template_versions')).rows).toEqual(locked);expect((await loadTemplate(db.pool,old.docKey,1)).ok).toBe(false);
  const t=JSON.parse(readFileSync('examples/row-groups-template.json','utf8'));let current=ok(await importCurrent(db.pool,JSON.stringify(t)));
  const v1=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'})),original=ok(await loadTemplate(db.pool,t.docKey,1));
  current.formats[0].payload.label='Changed';current.variables.find(v=>v.key==='name'&&current.variables.find(p=>p.id===v.parentId)?.key==='members').payload.description='Member name';
  current=ok(await saveCurrent(db.pool,current,current.revision));const v2=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'second'}));expect(v2.version).toBe(2);
  expect(ok(await loadTemplate(db.pool,t.docKey,1))).toEqual(original);expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'second'})).versionId).toBe(v2.versionId);
  for(const version of [v1,v2]){const rows=(await db.pool.query('SELECT v.* FROM variable_versions v JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE s.template_version_id=$1',[version.versionId])).rows;const bySource=new Map(rows.map(v=>[v.source_variable_id,v]));
   for(const v of current.variables){const cloned=bySource.get(v.id);expect(cloned.id).not.toBe(v.id);expect(cloned.parent_version_id).toBe(v.parentId?bySource.get(v.parentId).id:null);}
   await expect(db.pool.query("UPDATE variable_versions SET key='tampered' WHERE id=$1",[rows[0].id])).rejects.toBeDefined();
  }
  const format=current.formats[0],schema=current.schemas.find(s=>s.formatId===format.id);
  await expect(db.pool.query('UPDATE variable_schemas SET section_id=NULL WHERE id=$1',[schema.id])).rejects.toBeDefined();
  const outer=current.variables.find(v=>v.key==='companies'),inner=current.variables.find(v=>v.key==='members');
  await expect(db.pool.query('UPDATE variables SET parent_id=$1,schema_id=$2 WHERE id=$3',[outer.id,current.schemas.find(s=>s.id!==outer.schemaId).id,inner.id])).rejects.toBeDefined();
  const broken=structuredClone(current);broken.formats[0].payload.rowGroups[0].rowTemplateIds.reverse();expect((await saveCurrent(db.pool,broken,current.revision)).ok).toBe(false);expect(ok(await loadCurrent(db.pool,t.templateId))).toEqual(current);
 }finally{await db.close();}
});
