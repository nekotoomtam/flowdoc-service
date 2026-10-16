import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {loadTemplate,registerTemplate} from '../dist/templates/registry.js';
import {submitJob} from '../dist/jobs/admission.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
try{
 if(process.argv[2]==='write'){
  // Vitest fixtures use isolated schemas and are removed after each suite.
  // Seed public-schema persistence witnesses explicitly before the restart.
  const source=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
  const make=(key,version=1)=>({...structuredClone(source),templateId:'tpl-persist-'+key,docKey:key,version});
  for(const version of [1,2])ok(await registerTemplate(pool,JSON.stringify(make('versions',version))));
  ok(await registerTemplate(pool,JSON.stringify(make('pinned'))));
  const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));input.docKey='pinned';delete input.version;
  const job=ok(await submitJob(pool,input));
  ok(await registerTemplate(pool,JSON.stringify(make('pinned',2))));
  // Metadata/FK persistence only; this row is not a rendered-PDF acceptance claim.
  await pool.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES(uuidv7(),$1,'persistence-metadata-only.pdf','application/pdf',10)",[job.jobId]);
  console.log(JSON.stringify({status:'PASS',mode:'write',jobId:job.jobId}));
 }else{
 const v1=await loadTemplate(pool,'versions',1),v2=await loadTemplate(pool,'versions');assert.equal(v1.ok,true);assert.equal(v2.ok,true);assert.equal(v1.value.template.definition.version,1);assert.equal(v2.value.template.definition.version,2);
 const pinned=await pool.query("SELECT j.template_version_id,v.version,j.original_input,j.prepared_input FROM generation_jobs j JOIN template_versions v ON v.id=j.template_version_id JOIN templates t ON t.id=v.template_id WHERE t.doc_key='pinned'");
 assert.equal(pinned.rowCount,1);assert.equal(pinned.rows[0].version,1);assert.equal(pinned.rows[0].prepared_input.template.version,1);assert.equal(Object.hasOwn(pinned.rows[0].original_input,'version'),false);
 assert.equal(Number((await pool.query('SELECT count(*) AS count FROM document_outputs')).rows[0].count),1);
 const draft=(await pool.query("SELECT revision FROM template_current WHERE template_id='tpl-cli-current'")).rows[0];assert.equal(draft.revision,3);assert.equal((await pool.query("SELECT count(*)::int AS n FROM publication_receipts WHERE template_id='tpl-cli-current'")).rows[0].n,2);assert.equal((await loadTemplate(pool,'cli-current',1)).ok,true);assert.equal((await loadTemplate(pool,'cli-current',2)).ok,true);
 const counts=await pool.query('SELECT (SELECT count(*) FROM templates)::int AS templates,(SELECT count(*) FROM template_versions)::int AS versions,(SELECT count(*) FROM generation_jobs)::int AS jobs,(SELECT count(*) FROM document_outputs)::int AS outputs');
 console.log(JSON.stringify({status:'PASS',counts:counts.rows[0],checks:['versions persisted','job stayed pinned to version1','original/prepared preserved','output FK persisted','current revision and publication receipts persisted','old/new snapshot versions persisted']}));
 }
}finally{await pool.end();}
