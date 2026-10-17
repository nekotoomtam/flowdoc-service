import {LEGACY_SARABUN} from '../fonts/legacy.js';
import {validateFontSnapshot,makeFontSnapshot,persistJobFonts,fontRoot} from '../fonts/snapshot.js';
import {fingerprint} from '../fonts/repository.js';
import {loadBundledResources} from '@flowdoc/core';
import {failure} from '../errors.js';
import {tmpdir} from 'node:os';
import {imageNodes as collectImageNodes} from '../images/nodes.js';
import type {Pool} from 'pg';
import {validateTemplate,composeDocument,prepareGeneration} from '@flowdoc/core';
import {isDeepStrictEqual} from 'node:util';
import type {PdfArtifact,Result,PreparedInput,TemplateDefinition} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {claimNextJob,failJob,failInterruptedJobs} from './repository.js';
import type {PdfFiles,FilePolicy} from '../storage/pdf-files.js';
import {renderDocumentJob} from './render.js';
import {prepareOwnedJobImages,processing} from '../images/job.js';
import type {ImageJobDependencies,JobImageInput} from '../images/job.js';
interface Dependencies {pool:Pool;initialize?:()=>Promise<void>;resources?:ImageJobDependencies;files:{writePdf:(id:string,bytes:Uint8Array)=>Promise<{path:string;byteSize:number;release?:()=>void}>};policy:FilePolicy;pollMs?:number;render?:(prepared:PreparedInput,template:TemplateDefinition,signal:AbortSignal,images?:JobImageInput)=>Promise<Result<Pick<PdfArtifact,"bytes"|"mediaType">>>}
export async function startProcessor(deps:Dependencies){
 const {pool}=deps,lock=await pool.connect();let stopping=false,healthy=true;const abort=new AbortController();
 const lost=()=>{healthy=false;stopping=true;abort.abort();};lock.on('error',lost);
 try{const r=await lock.query('SELECT pg_try_advisory_lock(60430404) AS locked');if(!r.rows[0].locked)throw Error('Processor already active');await deps.initialize?.();await failInterruptedJobs(pool);}
 catch(e){lock.removeListener('error',lost);lock.release();throw e;}
 const loop=(async()=>{while(!stopping){
  try{
   const job=await claimAndStartRender(deps,abort.signal);if(!job){await new Promise(r=>setTimeout(r,deps.pollMs??100));continue;}
   try{
    const result=await job.pending;if(!result.ok){await failJob(pool,job.id,result.issues,result.warnings);continue;}
    if(!healthy)break;
    const output=await deps.files.writePdf(job.id,result.value.bytes);
    try{await transaction(pool,async c=>{
     const updated=await c.query("UPDATE generation_jobs SET status='succeeded',finished_at=now() WHERE id=$1 AND status='running' RETURNING id",[job.id]);if(updated.rowCount!==1)throw Error('Job transition conflict');
     await c.query("UPDATE job_processing SET stage='complete',warnings_json=warnings_json||$2::jsonb,updated_at=now() WHERE job_id=$1",[job.id,JSON.stringify(result.warnings)]);
     await c.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,retain,expires_at) VALUES(uuidv7(),$1,$2,'application/pdf',$3,$4 OR EXISTS(SELECT 1 FROM generation_jobs WHERE id=$1 AND preview_template_id IS NOT NULL),now()+($5 * interval '1 hour'))",[job.id,output.path,output.byteSize,deps.policy.retain,deps.policy.ttlHours]);
    });}finally{output.release?.();}
   }catch{await failJob(pool,job.id,[{code:'RENDER_FAILED',path:'job',message:'Document processing failed'}]);}
  }catch{lost();}
 }})();
 return {isReady:()=>healthy&&!stopping,async stop(){stopping=true;const timeout=setTimeout(()=>abort.abort(),5000);await loop;clearTimeout(timeout);try{if(healthy)await lock.query('SELECT pg_advisory_unlock(60430404)');}finally{lock.removeListener('error',lost);lock.release(!healthy);}}};
}

// This frame ends once transport starts. The waiting coordinator only retains the
// job ID and result promise, not the stored inputs, template or composed graph.
async function claimAndStartRender(deps:Dependencies,signal:AbortSignal){
 const {pool}=deps,job=await claimNextJob(pool);if(!job)return null;
 try{
    const row=job.versionId?(await pool.query('SELECT definition_json,fingerprint FROM template_versions WHERE id=$1',[job.versionId])).rows[0]:{definition_json:job.previewDefinition,fingerprint:job.previewFingerprint};
    const valid=validateTemplate(row?.definition_json);if(!valid.ok||valid.value.fingerprint!==row.fingerprint)throw Error('Invalid pinned template');
    {
     if(!job.originalInput||typeof job.originalInput!=='object'||Array.isArray(job.originalInput))throw Error('Invalid original input');
     const {uploadId,...original}=job.originalInput as Record<string,unknown>;
     const fresh=prepareGeneration(valid.value,original);if(!fresh.ok)throw Error('Invalid original input');
     // JSONB may reorder object keys and hence diagnostic order, but not entries.
     const warningKey=(w:PreparedInput['warnings'][number])=>JSON.stringify([w.code,w.path,w.message,w.action,w.contentIndex,w.format,w.expectedType,w.actualType]);
     const sortWarnings=(w:PreparedInput['warnings'])=>[...w].sort((a,b)=>warningKey(a).localeCompare(warningKey(b)));
     const comparable=(p:PreparedInput)=>({...p,warnings:sortWarnings(p.warnings),...(p.sections?{sections:Array.isArray(p.sections)?p.sections:Object.fromEntries(Object.entries(p.sections).map(([id,s])=>[id,{...s,warnings:sortWarnings(s.warnings)}]))}:{})});
     if(!isDeepStrictEqual(comparable(JSON.parse(JSON.stringify(fresh.value))),comparable(job.preparedInput)))throw Error('Prepared input differs from admission input');
    }
    const composed=composeDocument(valid.value,job.preparedInput);if(!composed.ok)throw Error('Composition failed');
    const hasImages=collectImageNodes(composed.value).length>0;
    if(hasImages&&!deps.resources)throw Error('Image preparation unavailable');
    let snapshot=job.fontSnapshot;
    if(!snapshot&&valid.value.definition.schemaVersion===1){
     const base=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot:tmpdir()});if(!base.ok)throw Error('Resources unavailable');
     snapshot=makeFontSnapshot(valid.value.fingerprint,fingerprint(job.originalInput),[],LEGACY_SARABUN.map(f=>({id:f.id,sha256:f.sha256})));
     await transaction(pool,c=>persistJobFonts(c,job.id,snapshot!));
    }
    const pinned=validateFontSnapshot(snapshot,valid.value.fingerprint,fingerprint(job.originalInput));
    const imageInput:JobImageInput=hasImages?await prepareOwnedJobImages(pool,job.id,composed.value,deps.resources!,signal):{document:composed.value,images:{}};
    imageInput.fontSnapshot=pinned;imageInput.fontStorageRoot=fontRoot();
    if(!hasImages)await processing(pool,job.id,'rendering',0,0,[]);
    const pending=deps.render?deps.render(job.preparedInput,valid.value.definition,signal,imageInput):renderDocumentJob(imageInput,signal);
    return {id:job.id,pending};

 }catch(e){const r=failure(e);await failJob(pool,job.id,r.ok?[]:r.issues[0]?.code.startsWith('FONT_')?r.issues:[{code:'RENDER_FAILED',path:'job',message:'Document processing failed'}]);return null;}
}
