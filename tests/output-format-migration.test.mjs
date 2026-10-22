import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
it('adds format/version metadata without rewriting existing pins, jobs or normalized digests',async()=>{
 const db=isolatedDatabase();await db.setup();try{
  await db.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of readdirSync('migrations').filter(n=>/^\d{3}_/.test(n)&&n<'025_').sort()){const sql=readFileSync('migrations/'+name,'utf8');await db.pool.query(sql);await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
  const tid='migration-format',vid=randomUUID(),id=randomUUID(),fid=randomUUID(),digest='a'.repeat(64),core={version:'old',sha256:'b'.repeat(64)},pin={docKey:'old',version:1,fingerprint:'c'.repeat(64)};
  await db.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$1,$1)',[tid]);await db.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,1,$3,$4)',[vid,tid,JSON.stringify({templateId:tid,docKey:tid,version:1}),pin.fingerprint]);
  await db.pool.query("INSERT INTO tasks(id,owner_key,created_by_principal,template_version_id,template_pin,resource_policy) VALUES($1,'owner','creator',$2,$3,'{}')",[id,vid,pin]);
  await db.pool.query("INSERT INTO task_files(id,task_id,role,logical_path,part_order,media_type,state,checksum,storage_key) VALUES($1,$2,'normalized','normalized-input-v1',0,'application/json','received',$3,$4)",[fid,id,digest,id+'/normalized/'+fid+'.bin']);
  const summary={coreVersion:core.version,coreSha256:core.sha256};await db.pool.query("UPDATE tasks SET status='validating',sealed_at=now(),input_digest=$2,normalized_at=now(),normalized_digest=$2,normalized_file_id=$3,normalization_summary=$4 WHERE id=$1",[id,digest,fid,summary]);
  const jid=randomUUID(),original={contract:'flowdoc-task-request/1',taskId:id,inputDigest:digest},prepared={contract:'flowdoc-task-job/1',taskId:id,normalizedFileId:fid,normalizedDigest:digest,core};await db.pool.query('INSERT INTO generation_jobs(id,task_id,template_version_id,original_input,prepared_input) VALUES($1,$2,$3,$4,$5)',[jid,id,vid,original,prepared]);
  const oid=randomUUID();await db.pool.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size) VALUES($1,$2,'old.pdf','application/pdf',10)",[oid,jid]);
  const history=(await db.pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const before=(await db.pool.query('SELECT template_pin,normalized_digest,normalization_summary FROM tasks WHERE id=$1',[id])).rows[0];const upgraded=await migrate(db.pool);expect(upgraded.ok,JSON.stringify(upgraded)).toBe(true);expect(upgraded.value.applied).toEqual(['025_task_output_format.sql']);
  expect((await db.pool.query('SELECT template_pin,normalized_digest,normalization_summary FROM tasks WHERE id=$1',[id])).rows[0]).toEqual(before);expect((await db.pool.query('SELECT output_format,normalization_version FROM tasks WHERE id=$1',[id])).rows[0]).toEqual({output_format:'pdf',normalization_version:1});expect((await db.pool.query('SELECT original_input,prepared_input,output_format FROM generation_jobs WHERE id=$1',[jid])).rows[0]).toEqual({original_input:original,prepared_input:prepared,output_format:'pdf'});
  expect((await db.pool.query('SELECT name,checksum FROM schema_migrations WHERE name<$1 ORDER BY name',['025_'])).rows).toEqual(history);
  expect((await db.pool.query('SELECT path,media_type,byte_size,page_count,output_format FROM document_outputs WHERE id=$1',[oid])).rows[0]).toMatchObject({path:'old.pdf',media_type:'application/pdf',byte_size:'10',page_count:null,output_format:'pdf'});
  expect((await migrate(db.pool)).value.applied).toEqual([]);
  // Historical job descriptors stay V1 and remain valid on ordinary state updates.
  await db.pool.query("UPDATE generation_jobs SET status='running' WHERE id=$1",[jid]);
  await expect(db.pool.query("UPDATE generation_jobs SET output_format='docx' WHERE id=$1",[jid])).rejects.toHaveProperty('code','55000');

  for(const format of ['pdf','docx']){
   const task=randomUUID(),file=randomUUID(),job=randomUUID();
   await db.pool.query("INSERT INTO tasks(id,owner_key,created_by_principal,template_version_id,template_pin,resource_policy,output_format) VALUES($1,'owner','creator',$2,$3,'{}',$4)",[task,vid,pin,format]);
   expect((await db.pool.query('SELECT normalization_version FROM tasks WHERE id=$1',[task])).rows[0].normalization_version).toBe(2);
   await expect(db.pool.query('UPDATE tasks SET normalization_version=1 WHERE id=$1',[task])).rejects.toHaveProperty('code','55000');
   await db.pool.query("INSERT INTO task_files(id,task_id,role,logical_path,part_order,media_type,state,checksum,storage_key) VALUES($1,$2,'normalized','normalized-input-v2',0,'application/json','received',$3,$4)",[file,task,digest,task+'/normalized/'+file+'.bin']);
   await expect(db.pool.query("UPDATE tasks SET normalization_summary=$2 WHERE id=$1",[task,{...summary,normalizationVersion:2}])).rejects.toHaveProperty('code','23514');
   await db.pool.query("UPDATE tasks SET status='validating',sealed_at=now(),input_digest=$2,normalized_at=now(),normalized_digest=$2,normalized_file_id=$3,normalization_summary=$4 WHERE id=$1",[task,digest,file,{...summary,normalizationVersion:2,outputFormat:format}]);
   const request={contract:'flowdoc-task-request/2',taskId:task,inputDigest:digest,outputFormat:format},receipt={contract:'flowdoc-task-job/2',taskId:task,normalizedFileId:file,normalizedDigest:digest,core,outputFormat:format};
   const insert=(r=request,p=receipt,f=format)=>db.pool.query('INSERT INTO generation_jobs(id,task_id,template_version_id,original_input,prepared_input,output_format) VALUES($1,$2,$3,$4,$5,$6)',[job,task,vid,r,p,f]);
   await expect(insert({...request,outputFormat:format==='pdf'?'docx':'pdf'})).rejects.toHaveProperty('code','23514');
   await expect(insert(request,{...receipt,contract:'flowdoc-task-job/1'})).rejects.toHaveProperty('code','23514');
   await expect(insert(request,receipt,format==='pdf'?'docx':'pdf')).rejects.toHaveProperty('code','23514');
   await insert();
   await expect(db.pool.query("UPDATE generation_jobs SET prepared_input='{}' WHERE id=$1",[job])).rejects.toHaveProperty('code','55000');
   const mime=format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
   const output=(f=format,m=mime,count=format==='pdf'?1:null)=>db.pool.query('INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,output_format,page_count) VALUES($1,$2,$3,$4,10,$5,$6)',[randomUUID(),job,'candidate.'+f,m,f,count]);
   await expect(output(format,mime,format==='pdf'?null:1)).rejects.toHaveProperty('code','23514');
   await expect(output(format,format==='pdf'?'application/octet-stream':'application/pdf')).rejects.toHaveProperty('code','23514');
   await expect(output(format==='pdf'?'docx':'pdf',format==='pdf'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf',format==='pdf'?null:1)).rejects.toHaveProperty('code','23514');
   await output();
  }
 }finally{await db.close();}
});
