import {it,expect} from 'vitest';import {readdirSync} from 'node:fs';import {mkdtemp,copyFile,appendFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {isolatedDatabase} from './isolatedDatabase.mjs';import {migrate} from '../dist/db/migrate.js';import {importCurrent,loadCurrent} from '../dist/templates/current.js';import {publishCurrent} from '../dist/templates/publish.js';import {loadTemplate} from '../dist/templates/registry.js';
import {ok,fixture,prepared,insertJob,baselineDir,removeDir} from './helpers/model20-db.mjs';
const migration='028_model20_section_definitions.sql';
const graph=async pool=>Object.fromEntries(await Promise.all(['section_versions','variable_schema_versions','variable_versions','format_versions','font_reference_sets','section_instance_history','publication_receipts'].map(async t=>[t,(await pool.query('SELECT to_jsonb(r) AS row FROM '+t+' r ORDER BY to_jsonb(r)::text')).rows])));
const functions=async pool=>(await pool.query("SELECT p.proname,pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname=ANY($1) ORDER BY p.proname",[['check_section_current_owner','check_section_version_owner','protect_preview_input','protect_job_input']])).rows;
it('upgrades genuine027 data/jobs without changing model18/19 graphs, snapshots, pins or history',async()=>{
 const db=isolatedDatabase(),base=await baselineDir();await db.setup();try{
  ok(await migrate(db.pool,base));const records=[];
  for(const model of [18,19]){const {t,request}=fixture(model,'upgrade-'+model),current=ok(await importCurrent(db.pool,JSON.stringify(t))),version=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'one'})),loaded=ok(await loadTemplate(db.pool,t.docKey,1));const job=await insertJob(db.pool,{versionId:version.versionId,t,request,p:prepared(t,request)});records.push({t,current,loaded,job,pin:(await db.pool.query('SELECT * FROM generation_jobs WHERE id=$1',[job])).rows[0]});}
  const graphs=await graph(db.pool),history=(await db.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  expect(ok(await migrate(db.pool)).applied).toEqual([migration]);expect(ok(await migrate(db.pool)).applied).toEqual([]);expect(await graph(db.pool)).toEqual(graphs);
  expect((await db.pool.query('SELECT * FROM schema_migrations WHERE name<>$1 ORDER BY name',[migration])).rows).toEqual(history);
  for(const r of records){expect(ok(await loadCurrent(db.pool,r.t.templateId))).toEqual(r.current);expect(ok(await loadTemplate(db.pool,r.t.docKey,1))).toEqual(r.loaded);expect((await db.pool.query('SELECT * FROM generation_jobs WHERE id=$1',[r.job])).rows[0]).toEqual(r.pin);await insertJob(db.pool,{versionId:r.pin.template_version_id,t:r.t,request:r.t.examples[0].request});}
 }finally{await db.close();await removeDir(base)}
});
it('rolls back new function definitions and checksum ledger atomically after injected migration failure',async()=>{
 const db=isolatedDatabase(),base=await baselineDir(),bad=await mkdtemp(join(tmpdir(),'m20-failure-'));await db.setup();try{
  ok(await migrate(db.pool,base));const {t}=fixture(19,'failed-upgrade');const current=ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'one'}));const prior=await functions(db.pool),ledger=(await db.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  for(const n of readdirSync('migrations').filter(n=>/^\d{3}_/.test(n)))await copyFile('migrations/'+n,join(bad,n));
  await appendFile(join(bad,migration),'\nSELECT 1/0;\n');expect((await migrate(db.pool,bad)).ok).toBe(false);
  expect(await functions(db.pool)).toEqual(prior);expect((await db.pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows).toEqual(ledger);expect(ok(await loadCurrent(db.pool,t.templateId))).toEqual(current);
  expect(ok(await migrate(db.pool)).applied).toEqual([migration]);
 }finally{await db.close();await removeDir(base);await removeDir(bad)}
});
