import type {Pool,PoolClient} from 'pg';
import type {Result,Issue,PreparedInput} from '@flowdoc/core';
import {failure,OperationError} from '../errors.js';
import type {Job,JobView} from './types.js';
type Queryable=Pool|PoolClient;
export const validJobId=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export async function getJob(pool:Queryable,id:string,includePreview=false):Promise<Result<JobView>>{
 if(!validJobId(id))return failure(new OperationError('INVALID_JOB_ID','jobId','Invalid job ID'));
 try{
  const r=await pool.query('SELECT j.id,j.status,j.warnings_json,j.skipped_indices,j.errors_json,COALESCE(v.version,0) AS version FROM generation_jobs j LEFT JOIN template_versions v ON v.id=j.template_version_id WHERE j.id=$1 AND j.task_id IS NULL AND (j.template_version_id IS NOT NULL OR $2)',[id,includePreview]);
  const row=r.rows[0];if(!row)return failure(new OperationError('JOB_NOT_FOUND','jobId','Job not found'));
  const progress=(await pool.query('SELECT stage,completed,total,warnings_json FROM job_processing WHERE job_id=$1',[id])).rows[0];
  const warnings=[...row.warnings_json,...(progress?.warnings_json??[])];
  return {ok:true,value:{jobId:row.id,version:row.version,status:row.status,hasWarnings:warnings.length>0,warnings,skippedContentIndices:row.skipped_indices,errors:row.errors_json,...(progress?{processing:{stage:progress.stage,completed:progress.completed,total:progress.total,warningCount:progress.warnings_json.length}}:{})},warnings};
 }catch(error){return failure(error);}
}
export async function claimNextJob(pool:Queryable):Promise<Job|null>{
 const r=await pool.query(`UPDATE generation_jobs SET status='running',started_at=now() WHERE id=(SELECT id FROM generation_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) AND status='queued' AND task_id IS NULL RETURNING id,template_version_id,prepared_input,original_input,preview_definition,preview_fingerprint`);
 const row=r.rows[0];
 const fonts=row?(await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1',[row.id])).rows[0]?.snapshot:undefined;
 return row?{...(fonts?{fontSnapshot:fonts}:{}),id:row.id,versionId:row.template_version_id,preparedInput:row.prepared_input,originalInput:row.original_input,...(row.preview_definition?{previewDefinition:row.preview_definition,previewFingerprint:row.preview_fingerprint}:{})}:null;
}
export async function failJob(pool:Queryable,id:string,issues:Issue[],warnings:Issue[]=[]):Promise<boolean>{
 const r=await pool.query("WITH failed AS (UPDATE generation_jobs SET status='failed',finished_at=now(),errors_json=$2 WHERE id=$1 AND status='running' RETURNING id), progress AS (UPDATE job_processing p SET stage='failed',warnings_json=p.warnings_json||$3::jsonb,updated_at=now() FROM failed f WHERE p.job_id=f.id RETURNING p.job_id) SELECT id FROM failed",[id,JSON.stringify(issues),JSON.stringify(warnings)]);return r.rowCount===1;
}
export async function failInterruptedJobs(pool:Queryable):Promise<void>{
 await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now(),errors_json=$1 WHERE status='running' AND task_id IS NULL",[JSON.stringify([{code:'PROCESS_INTERRUPTED',path:'job',message:'Processing interrupted; submit a new job'}])]);
 await pool.query("UPDATE job_processing SET stage='failed',updated_at=now() WHERE job_id IN (SELECT id FROM generation_jobs WHERE status='failed') AND stage<>'failed'");
}
