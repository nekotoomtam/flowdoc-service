import {createHash} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {validateTemplate} from '@flowdoc/core';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
const fixture=key=>{const t=JSON.parse(readFileSync('examples/area-template.json','utf8'));t.docKey=t.templateId=key;return t;};
it('clones ownership and preserves published versions after current deletion',async()=>{
 const t=fixture('area-version');const current=ok(await importCurrent(db.pool,JSON.stringify(t)));const v1=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'one'}));const old=ok(await loadTemplate(db.pool,t.docKey,v1.version));
 let r=ok(await loadCurrent(db.pool,t.templateId));const owner=r.variables.find(v=>v.typeId===110006);owner.key='renamed';r=ok(await saveCurrent(db.pool,r,r.revision));const v2=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'two'}));expect(v2.version).toBe(2);expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'two'}))).toMatchObject({version:2,created:false});
 const rows=await db.pool.query('SELECT f.id,f.owner_area_variable_version_id,v.source_variable_id,s.template_version_id FROM format_versions f JOIN variable_versions v ON v.id=f.owner_area_variable_version_id JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE f.template_version_id=$1 AND v.source_variable_id=$2',[v2.versionId,owner.id]);expect(rows.rows).toHaveLength(2);expect(rows.rows.every(x=>x.template_version_id===v2.versionId&&x.source_variable_id===owner.id&&x.owner_area_variable_version_id!==owner.id)).toBe(true);
 r.variables=r.variables.filter(v=>v.id!==owner.id);const saved=ok(await saveCurrent(db.pool,r,r.revision));expect(saved.formats.some(f=>f.ownerAreaVariableId===owner.id)).toBe(false);expect(saved.formats.find(f=>f.key==='evidence').payload.fragment.nodes.placement).toBeUndefined();ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'three'}));expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(old.template);expect(current.formats.some(f=>f.ownerAreaVariableId)).toBe(true);
});
it('rejects wrong-template owner at SQL boundary and last-subformat removal at publication',async()=>{
 const a=ok(await importCurrent(db.pool,JSON.stringify(fixture('area-a')))),b=ok(await importCurrent(db.pool,JSON.stringify(fixture('area-b'))));const f=a.formats.find(f=>f.ownerAreaVariableId),owner=b.variables.find(v=>v.typeId===110006);await expect(db.pool.query('UPDATE formats SET owner_area_variable_id=$1 WHERE id=$2',[owner.id,f.id])).rejects.toThrow();
 const c=ok(await loadCurrent(db.pool,'area-a')),removed=new Set(c.formats.filter(f=>f.ownerAreaVariableId).map(f=>f.id)),schemas=new Set(c.schemas.filter(s=>removed.has(s.formatId)).map(s=>s.id));c.formats=c.formats.filter(f=>!removed.has(f.id));c.schemas=c.schemas.filter(s=>!schemas.has(s.id));c.variables=c.variables.filter(v=>!schemas.has(v.schemaId));ok(await saveCurrent(db.pool,c,c.revision));expect((await publishCurrent(db.pool,{templateId:'area-a',requestId:'bad'})).ok).toBe(false);
});

it('upgrades populated prior schema without rewriting the published definition',async()=>{
 const legacy=isolatedDatabase();await legacy.setup();try{
 await legacy.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of readdirSync('migrations').filter(n=>/^00[1-8]_/.test(n)).sort()){const sql=readFileSync('migrations/'+name,'utf8');await legacy.pool.query(sql);await legacy.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
 const t=JSON.parse(readFileSync('examples/cell-repeat-template.json','utf8')),valid=ok(validateTemplate(t));await legacy.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[t.templateId,t.docKey,t.name]);
 const id=(await legacy.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES(uuidv7(),$1,1,$2,$3) RETURNING id',[t.templateId,JSON.stringify(t),valid.fingerprint])).rows[0].id;
 const r=ok(await migrate(legacy.pool));expect(r.applied).toEqual(['009_area_ownership.sql','010_page_band_schemas.sql','011_section_ownership.sql','012_page_numbering.sql']);const after=(await legacy.pool.query('SELECT definition_json,fingerprint FROM template_versions WHERE id=$1',[id])).rows[0];expect(after).toEqual({definition_json:t,fingerprint:valid.fingerprint});expect(ok(await loadTemplate(legacy.pool,t.docKey,1)).template.fingerprint).toBe(valid.fingerprint);
 }finally{await legacy.close();}
});
