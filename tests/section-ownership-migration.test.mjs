import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {validateTemplate} from '@flowdoc/core';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {decompose} from '../dist/templates/assembly.js';
import {loadTemplate} from '../dist/templates/registry.js';
it('adds011 to populated010 without rewriting current or published definitions and identifiers',async()=>{
 const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};await db.setup();try{
 await db.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of readdirSync('migrations').filter(n=>/^(00[1-9]|010)_/.test(n)).sort()){const sql=readFileSync('migrations/'+name,'utf8');await db.pool.query(sql);await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
 const t=JSON.parse(readFileSync('examples/page-bands-template.json','utf8'));t.templateId=t.docKey='legacy010';t.globalSchema={type:'object',fields:{}};t.formats={};delete t.areaFormats;delete t.header;delete t.footer;t.sections=[{id:'body',source:{kind:'authored',repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'text',text:'legacy'}]}}}}}];t.examples=[];
 const v=ok(validateTemplate(t)),r=decompose(t,randomUUID),versionId=randomUUID(),schemaVersionId=randomUUID();
 await db.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[t.templateId,t.docKey,t.name]);await db.pool.query('INSERT INTO template_current(template_id,payload) VALUES($1,$2)',[t.templateId,JSON.stringify(r.payload)]);await db.pool.query("INSERT INTO variable_schemas(id,template_id,scope) VALUES($1,$2,'global')",[r.schemas[0].id,t.templateId]);
 await db.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[versionId,t.templateId,JSON.stringify(t),v.fingerprint]);await db.pool.query('INSERT INTO template_snapshots(version_id,payload) VALUES($1,$2)',[versionId,JSON.stringify(r.payload)]);await db.pool.query("INSERT INTO variable_schema_versions(id,template_version_id,scope) VALUES($1,$2,'global')",[schemaVersionId,versionId]);
 const before=(await db.pool.query('SELECT * FROM template_current WHERE template_id=$1',[t.templateId])).rows[0];expect(ok(await migrate(db.pool)).applied).toEqual(['011_section_ownership.sql','012_page_numbering.sql']);expect((await db.pool.query('SELECT * FROM template_current WHERE template_id=$1',[t.templateId])).rows[0]).toEqual(before);expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(v);expect((await db.pool.query('SELECT id,section_id FROM variable_schemas WHERE id=$1',[r.schemas[0].id])).rows).toEqual([{id:r.schemas[0].id,section_id:null}]);expect((await db.pool.query('SELECT id,section_version_id FROM variable_schema_versions WHERE id=$1',[schemaVersionId])).rows).toEqual([{id:schemaVersionId,section_version_id:null}]);
 }finally{await db.close();}
});
