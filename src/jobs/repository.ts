import type {Pool,PoolClient} from 'pg';
import type {Result,Issue,PreparedInput} from '@flowdoc/core';
import {failure,OperationError} from '../errors.js';
import type {Job,JobView} from './types.js';
type Queryable=Pool|PoolClient;
export const validJobId=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export async function getJob(pool:Queryable,id:string):Promise<Result<JobView>>{
 if(!validJobId(id))return failure(new OperationError('INVALID_JOB_ID','jobId','Invalid job ID'));
 try{
  const r=await pool.query('SELECT j.id,j.status,j.warnings_json,j.skipped_indices,j.errors_json,v.version FROM generation_jobs j JOIN template_versions v ON v.id=j.template_version_id WHERE j.id=$1',[id]);
  const row=r.rows[0];if(!row)return failure(new OperationError('JOB_NOT_FOUND','jobId','Job not found'));
  const progress=(await pool.query('SELECT stage,completed,total,warnings_json FROM job_processing WHERE job_id=$1',[id])).rows[0];
  const warnings=[...row.warnings_json,...(progress?.warnings_json??[])];
  return {ok:true,value:{jobId:row.id,version:row.version,status:row.status,hasWarnings:warnings.length>0,warnings,skippedContentIndices:row.skipped_indices,errors:row.errors_json,...(progress?{processing:{stage:progress.stage,completed:progress.completed,total:progress.total,warningCount:progress.warnings_json.length}}:{})},warnings};
 }catch(error){return failure(error);}
}
export async function claimNextJob(pool:Queryable):Promise<Job|null>{
 const r=await pool.query<{id:string;template_version_id:string;prepared_input:PreparedInput;original_input:unknown}>(`UPDATE generation_jobs SET status='running',started_at=now() WHERE id=(SELECT id FROM generation_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) AND status='queued' RETURNING id,template_version_id,prepared_input,original_input`);
 const row=r.rows[0];return row?{id:row.id,versionId:row.template_version_id,preparedInput:row.prepared_input,originalInput:row.original_input}:null;
}
export async function failJob(pool:Queryable,id:string,issues:Issue[]):Promise<boolean>{
 const r=await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now(),errors_json=$2 WHERE id=$1 AND status='running'",[id,JSON.stringify(issues)]);if(r.rowCount===1)await pool.query("UPDATE job_processing SET stage='failed',updated_at=now() WHERE job_id=$1",[id]);return r.rowCount===1;
}
export async function failInterruptedJobs(pool:Queryable):Promise<void>{
 await pool.query("UPDATE generation_jobs SET status='failed',finished_at=now(),errors_json=$1 WHERE status='running'",[JSON.stringify([{code:'PROCESS_INTERRUPTED',path:'job',message:'Processing interrupted; submit a new job'}])]);
 await pool.query("UPDATE job_processing SET stage='failed',updated_at=now() WHERE job_id IN (SELECT id FROM generation_jobs WHERE status='failed') AND stage<>'failed'");
}
