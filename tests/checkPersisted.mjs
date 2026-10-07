import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {loadTemplate} from '../dist/templates/registry.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const v1=await loadTemplate(pool,'versions',1),v2=await loadTemplate(pool,'versions');assert.equal(v1.ok,true);assert.equal(v2.ok,true);assert.equal(v1.value.template.definition.version,1);assert.equal(v2.value.template.definition.version,2);
 const pinned=await pool.query("SELECT j.template_version_id,v.version,j.original_input,j.prepared_input FROM generation_jobs j JOIN template_versions v ON v.id=j.template_version_id JOIN templates t ON t.id=v.template_id WHERE t.doc_key='pinned'");
 assert.equal(pinned.rowCount,1);assert.equal(pinned.rows[0].version,1);assert.equal(pinned.rows[0].prepared_input.template.version,1);assert.equal(Object.hasOwn(pinned.rows[0].original_input,'version'),false);
 assert.equal(Number((await pool.query('SELECT count(*) AS count FROM document_outputs')).rows[0].count),1);
 const counts=await pool.query('SELECT (SELECT count(*) FROM templates)::int AS templates,(SELECT count(*) FROM template_versions)::int AS versions,(SELECT count(*) FROM generation_jobs)::int AS jobs,(SELECT count(*) FROM document_outputs)::int AS outputs');
 console.log(JSON.stringify({status:'PASS',counts:counts.rows[0],checks:['versions persisted','job stayed pinned to version1','original/prepared preserved','output FK persisted']}));
}finally{await pool.end();}
