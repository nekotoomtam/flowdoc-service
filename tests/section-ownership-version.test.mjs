import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {decompose} from '../dist/templates/assembly.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const fixture=(key)=>{const t=JSON.parse(readFileSync('examples/section-ownership-template.json','utf8'));t.templateId=t.docKey=key;for(const s of t.sections)s.formats.same={inputSchema:{type:'object',fields:{text:{type:'string'}}},fragment:structuredClone(s.source.fragment),repeats:[]};return t;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
it('retains current IDs/times, swaps order and clones immutable versions without changing authored identity',async()=>{
 const t=fixture('section-version'),c=ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'one'}));const original=ok(await loadTemplate(db.pool,t.docKey,1));
 const times=(await db.pool.query('SELECT id,created_at FROM sections WHERE template_id=$1 ORDER BY id',[t.templateId])).rows;
 c.sections[0].position=1;c.sections[1].position=0;c.sections[0].label='renamed';let saved=ok(await saveCurrent(db.pool,c,c.revision));expect((await db.pool.query('SELECT id,created_at FROM sections WHERE template_id=$1 ORDER BY id',[t.templateId])).rows).toEqual(times);
 expect(ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'two'})).version).toBe(2);expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(original.template);
 const versions=(await db.pool.query('SELECT s.* FROM section_versions s JOIN template_versions v ON v.id=s.template_version_id WHERE v.template_id=$1',[t.templateId])).rows;expect(new Set(versions.map(v=>v.id)).size).toBe(6);expect(versions.every(v=>!c.sections.some(s=>s.id===v.id)&&c.sections.some(s=>s.id===v.source_section_id&&s.sourceDefinitionId===v.source_definition_id))).toBe(true);
 await expect(db.pool.query("UPDATE section_versions SET label='bad' WHERE id=$1",[versions[0].id])).rejects.toBeDefined();
 const globalIds=saved.variables.filter(v=>saved.schemas.some(s=>s.scope==='global'&&s.id===v.schemaId)).map(v=>v.id);const removed=saved.sections[0].id;saved.sections=saved.sections.filter(s=>s.id!==removed);saved=ok(await saveCurrent(db.pool,saved,saved.revision));expect(saved.schemas.some(s=>s.sectionId===removed)).toBe(false);expect(saved.formats.some(s=>s.sectionId===removed)).toBe(false);expect(globalIds.every(id=>saved.variables.some(v=>v.id===id))).toBe(true);expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(original.template);
});
it('rejects owner moves, stale revision and NULL schema/format mismatches in DB',async()=>{
 const t=fixture('section-fk'),c=ok(await importCurrent(db.pool,JSON.stringify(t)));const f=c.formats[0],schema=c.schemas.find(s=>s.formatId===f.id);
 await expect(db.pool.query('UPDATE variable_schemas SET section_id=NULL WHERE id=$1',[schema.id])).rejects.toBeDefined();await expect(db.pool.query('UPDATE formats SET section_id=$1 WHERE id=$2',[c.sections[1].id,f.id])).rejects.toBeDefined();
 const changed=structuredClone(c);changed.formats[0].sectionId=c.sections[1].id;changed.schemas.find(s=>s.id===schema.id).sectionId=c.sections[1].id;changed.formats[0].key='moved';expect((await saveCurrent(db.pool,changed,c.revision)).ok).toBe(false);expect((await saveCurrent(db.pool,c,c.revision+1)).ok).toBe(false);
 const other=ok(await importCurrent(db.pool,JSON.stringify(fixture('section-other'))));await expect(db.pool.query('UPDATE variable_schemas SET section_id=$1 WHERE id=$2',[other.sections[0].id,schema.id])).rejects.toBeDefined();
});
it('accepts explicit complete legacy upgrade and rejects incomplete mapping without mutating old version',async()=>{
 const old=JSON.parse(readFileSync('examples/page-bands-template.json','utf8'));old.templateId=old.docKey='section-upgrade';const before=ok(await importCurrent(db.pool,JSON.stringify(old)));ok(await publishCurrent(db.pool,{templateId:old.templateId,requestId:'legacy'}));const legacy=ok(await loadTemplate(db.pool,old.docKey,1));const next=decompose(fixture('section-upgrade'),randomUUID);next.revision=before.revision;
 const broken=structuredClone(next);broken.schemas=broken.schemas.filter(s=>s.scope!=='section');expect((await saveCurrent(db.pool,broken,before.revision)).ok).toBe(false);expect(ok(await loadCurrent(db.pool,old.templateId)).revision).toBe(before.revision);ok(await saveCurrent(db.pool,next,before.revision));ok(await publishCurrent(db.pool,{templateId:old.templateId,requestId:'modern'}));expect(ok(await loadTemplate(db.pool,old.docKey,1)).template).toEqual(legacy.template);
});
