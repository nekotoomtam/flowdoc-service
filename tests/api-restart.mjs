import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {utimes} from 'node:fs/promises';
import {submitJob} from '../dist/jobs/admission.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {renderPinnedJob} from '../dist/jobs/render.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {prepareGeneration} from '@flowdoc/core';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const ok=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value;};
try{
 const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));
 input.content.push({format:'missing',data:{}});
 const queued=ok(await submitJob(pool,input)),running=ok(await submitJob(pool,input)),succeeded=ok(await submitJob(pool,input));
 await pool.query("UPDATE generation_jobs SET status='running',started_at=now() WHERE id=$1",[running.jobId]);
 const template=ok(await loadTemplate(pool,input.docKey,1)).template;
 const pdf=ok(await renderPinnedJob(ok(prepareGeneration(template,input)),template.definition));
 const files=await createPdfFiles('/app/output');await files.writePdf(running.jobId,Buffer.from('%PDF-orphan'));await utimes('/app/output/'+running.jobId+'.pdf',new Date(0),new Date(0));const output=await files.writePdf(succeeded.jobId,pdf.bytes);
 await pool.query("UPDATE generation_jobs SET status='succeeded',finished_at=now() WHERE id=$1",[succeeded.jobId]);
 await pool.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,retain) VALUES(uuidv7(),$1,$2,'application/pdf',$3,true)",[succeeded.jobId,output.path,output.byteSize]);
 console.log(JSON.stringify({queued:queued.jobId,running:running.jobId,succeeded:succeeded.jobId}));
}finally{await pool.end();}
