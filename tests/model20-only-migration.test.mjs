import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,copyFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';import {assertRuntimeSchema} from '../dist/db/runtime-schema.js';
import {importCurrent,loadCurrent} from '../dist/templates/current.js';import {publishCurrent} from '../dist/templates/publish.js';import {loadTemplate} from '../dist/templates/registry.js';
import {model20Fixture} from './helpers/model20.mjs';
const migration='029_model20_only.sql',ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const tables=['templates','template_current','sections','formats','variable_schemas','variables','template_versions','template_snapshots','section_versions','format_versions','variable_schema_versions','variable_versions','generation_jobs','font_reference_sets','publication_receipts','schema_migrations'];
const snapshot=async pool=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await pool.query('SELECT to_jsonb(r) AS row FROM '+t+' r ORDER BY to_jsonb(r)::text')).rows])));
async function directory(include29=false){const d=await mkdtemp(join(tmpdir(),'m20-only-'));for(const n of readdirSync('migrations').filter(n=>/^\d{3}_/.test(n)&&(include29||n<migration)))await copyFile('migrations/'+n,join(d,n));return d;}
async function remove(d){if(!d.startsWith(join(tmpdir(),'m20-only-')))throw Error('Unexpected lab directory');await rm(d,{recursive:true,force:true});}
async function withDb(fn){const db=isolatedDatabase();await db.setup();try{await fn(db.pool);}finally{await db.close();}}
function template(){const t=model20Fixture();t.templateId=randomUUID();t.docKey='model20-'+t.templateId;for(const e of t.examples)e.request.docKey=t.docKey;return t;}
it('creates a fresh029 namespace, publishes20 and preserves its exact definition/contract on replay',async()=>withDb(async pool=>{
 const applied=ok(await migrate(pool)).applied;expect(applied).toHaveLength(29);expect(applied.at(-1)).toBe(migration);await assertRuntimeSchema(pool);
 const t=template(),current=ok(await importCurrent(pool,JSON.stringify(t))),v=ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'publish20'}));
 expect(ok(await loadCurrent(pool,t.templateId))).toEqual(current);expect(ok(await loadTemplate(pool,t.docKey,1)).template.definition).toEqual(t);
 const before=await snapshot(pool);expect(ok(await migrate(pool)).applied).toEqual([]);expect(await snapshot(pool)).toEqual(before);expect(v.version).toBe(1);
}));
it('upgrades028 containing only20 without changing definitions, rows or prior ledger checksums',async()=>withDb(async pool=>{
 const d=await directory();try{ok(await migrate(pool,d));const t=template();ok(await importCurrent(pool,JSON.stringify(t)));ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'one'}));
 const before=await snapshot(pool);await expect(assertRuntimeSchema(pool)).rejects.toMatchObject({code:'RUNTIME_SCHEMA_REQUIRED'});
 expect(ok(await migrate(pool)).applied).toEqual([migration]);const after=await snapshot(pool);expect(after.schema_migrations.filter(r=>r.row.name!==migration)).toEqual(before.schema_migrations);delete before.schema_migrations;delete after.schema_migrations;expect(after).toEqual(before);await assertRuntimeSchema(pool);
 }finally{await remove(d);}
}));
it.each([18,19])('refuses genuine legacy%d graphs/snapshots/jobs from the frozen old Service atomically',async model=>withDb(async pool=>{
 const d=await directory();try{ok(await migrate(pool,d));const root=process.env.FLOWDOC_LEGACY_SERVICE_ROOT;if(!root)throw Error('Dedicated frozen legacy Service lab mount required');
 const oldImport=(await import(pathToFileURL(join(root,'dist/templates/current.js')).href)).importCurrent,oldPublish=(await import(pathToFileURL(join(root,'dist/templates/publish.js')).href)).publishCurrent;
 const oldCore=await import(pathToFileURL(join(root,'node_modules/@flowdoc/core/dist/index.js')).href);
 const t=JSON.parse(readFileSync(join(root,model===18?'examples/area-document-template.json':'tests/fixtures/format-sizing/template.json'),'utf8'));
 const request=JSON.parse(readFileSync(join(root,model===18?'examples/area-document-request.json':'tests/fixtures/format-sizing/request.json'),'utf8'));
 t.templateId=t.docKey='legacy-'+model+'-'+randomUUID();request.docKey=t.docKey;request.version=t.version;t.examples=[{name:'retained',request}];
 ok(await oldImport(pool,JSON.stringify(t)));const version=ok(await oldPublish(pool,{templateId:t.templateId,requestId:'legacy'}));const p=ok(oldCore.prepareGeneration(ok(oldCore.validateTemplate(t)),request));
 await pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),version.versionId,request,p,JSON.stringify(p.warnings),JSON.stringify(p.skippedContentIndices)]);
 const before=await snapshot(pool),r=await migrate(pool);expect(r).toMatchObject({ok:false,issues:[{code:'LEGACY_MODEL_DATA',path:'migration'}]});expect(await snapshot(pool)).toEqual(before);expect((await pool.query('SELECT name FROM schema_migrations WHERE name=$1',[migration])).rowCount).toBe(0);
 }finally{await remove(d);}
}));
it('rolls back029 constraints and ledger after a post-DDL failure, then upgrades successfully',async()=>withDb(async pool=>{
 const base=await directory(),bad=await directory(true);try{ok(await migrate(pool,base));const t=template();ok(await importCurrent(pool,JSON.stringify(t)));ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'before'}));const before=await snapshot(pool);
 await appendFile(join(bad,migration),'\nSELECT 1/0;\n');expect((await migrate(pool,bad)).ok).toBe(false);expect(await snapshot(pool)).toEqual(before);expect((await pool.query("SELECT 1 FROM pg_constraint WHERE conname='template_current_model20_only' AND connamespace=current_schema()::regnamespace")).rowCount).toBe(0);
 expect(ok(await migrate(pool)).applied).toEqual([migration]);await assertRuntimeSchema(pool);
 }finally{await remove(base);await remove(bad);}
}));
it('enforces numeric20 at the SQL boundary and preserves the original current row on refusal',async()=>withDb(async pool=>{
 ok(await migrate(pool));const t=template();ok(await importCurrent(pool,JSON.stringify(t)));const before=await snapshot(pool);
 for(const value of [18,19,null,'20'])await expect(pool.query("UPDATE template_current SET payload=jsonb_set(payload,'{nodeModelVersion}',$2::jsonb) WHERE template_id=$1",[t.templateId,JSON.stringify(value)])).rejects.toMatchObject({code:'23514'});
 expect(await snapshot(pool)).toEqual(before);
}));
it('refuses a changed029 checksum using a real ledger and becomes ready after exact restoration',async()=>withDb(async pool=>{
 ok(await migrate(pool));await assertRuntimeSchema(pool);const row=(await pool.query('SELECT checksum FROM schema_migrations WHERE name=$1',[migration])).rows[0];await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2',['0'.repeat(64),migration]);await expect(assertRuntimeSchema(pool)).rejects.toMatchObject({code:'RUNTIME_SCHEMA_REQUIRED'});await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE name=$2',[row.checksum,migration]);await assertRuntimeSchema(pool);
}));
