import type {Pool} from 'pg';
import {validateTemplate,composeDocument} from '@flowdoc/core';
import type {PdfArtifact,Result,PreparedInput,TemplateDefinition} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {claimNextJob,failJob,failInterruptedJobs} from './repository.js';
import type {PdfFiles,FilePolicy} from '../storage/pdf-files.js';
import {renderPinnedJob} from './render.js';
import {prepareJobImages,processing} from '../images/job.js';
import type {ImageJobDependencies,JobImageInput} from '../images/job.js';
interface Dependencies {pool:Pool;initialize?:()=>Promise<void>;resources?:ImageJobDependencies;files:{writePdf:(id:string,bytes:Uint8Array)=>Promise<{path:string;byteSize:number;release?:()=>void}>};policy:FilePolicy;pollMs?:number;render?:(prepared:PreparedInput,template:TemplateDefinition,signal:AbortSignal,images?:JobImageInput)=>Promise<Result<Pick<PdfArtifact,"bytes"|"mediaType">>>}
export async function startProcessor(deps:Dependencies){
 const {pool}=deps,lock=await pool.connect();let stopping=false,healthy=true;const abort=new AbortController();
 const lost=()=>{healthy=false;stopping=true;abort.abort();};lock.on('error',lost);
 try{const r=await lock.query('SELECT pg_try_advisory_lock(60430404) AS locked');if(!r.rows[0].locked)throw Error('Processor already active');await deps.initialize?.();await failInterruptedJobs(pool);}
 catch(e){lock.removeListener('error',lost);lock.release();throw e;}
 const render=deps.render??((p,t,s,images)=>renderPinnedJob(p,t,s,undefined,undefined,undefined,images));
 const loop=(async()=>{while(!stopping){
  try{
   const job=await claimNextJob(pool);if(!job){await new Promise(r=>setTimeout(r,deps.pollMs??100));continue;}
   try{
    const row=(await pool.query('SELECT definition_json,fingerprint FROM template_versions WHERE id=$1',[job.versionId])).rows[0];
    const valid=validateTemplate(row?.definition_json);if(!valid.ok||valid.value.fingerprint!==row.fingerprint)throw Error('Invalid pinned template');
    const composed=composeDocument(valid.value,job.preparedInput);if(!composed.ok)throw Error('Composition failed');
    const hasImages=Object.values(composed.value.nodes).some(n=>n.type==='image');
    if(hasImages&&!deps.resources)throw Error('Image preparation unavailable');
    const imageInput=hasImages?await prepareJobImages(pool,job.id,composed.value,deps.resources!,abort.signal):{document:composed.value,images:{}};
    if(!hasImages)await processing(pool,job.id,'rendering',0,0,[]);
    const result=await render(job.preparedInput,valid.value.definition,abort.signal,imageInput);if(!result.ok){await failJob(pool,job.id,result.issues);continue;}
    if(!healthy)break;
    const output=await deps.files.writePdf(job.id,result.value.bytes);
    try{await transaction(pool,async c=>{
     const updated=await c.query("UPDATE generation_jobs SET status='succeeded',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]);if(updated.rowCount!==1)throw Error('Job transition conflict');
     await c.query("UPDATE job_processing SET stage='complete',warnings_json=warnings_json||$2::jsonb,updated_at=now() WHERE job_id=$1",[job.id,JSON.stringify(result.warnings)]);
     await c.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,retain,expires_at) VALUES(uuidv7(),$1,$2,'application/pdf',$3,$4,now()+($5 * interval '1 hour'))",[job.id,output.path,output.byteSize,deps.policy.retain,deps.policy.ttlHours]);
    });}finally{output.release?.();}
   }catch{await failJob(pool,job.id,[{code:'RENDER_FAILED',path:'job',message:'Document processing failed'}]);}
  }catch{lost();}
 }})();
 return {isReady:()=>healthy&&!stopping,async stop(){stopping=true;const timeout=setTimeout(()=>abort.abort(),5000);await loop;clearTimeout(timeout);try{if(healthy)await lock.query('SELECT pg_advisory_unlock(60430404)');}finally{lock.removeListener('error',lost);lock.release(!healthy);}}};
}
