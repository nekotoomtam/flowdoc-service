import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,copyFile,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createUploads} from '../dist/uploads/service.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {decompose} from '../dist/templates/assembly.js';
import {prepareGeneration,validateTemplate} from '@flowdoc/core';
const db=isolatedDatabase();let files,time=Date.now();
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);files=await createResourceFiles(await mkdtemp(join(tmpdir(),'upload-acceptance-')));});
afterAll(()=>db.close());
const manifest=()=>({requestKey:randomUUID(),items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:3}]});
const make=(extra={})=>createUploads({pool:db.pool,files,config:readUploadConfig({}),clock:()=>time,...extra});
const bytes=()=>Readable.from([Buffer.from('abc')]);
it('ENOSPC rejects the receipt and permits retry without releasing set reservation',async()=>{
 const u=make({files:{...files,receive:async()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});}}});
 const s=await u.create(manifest());await expect(u.receive(s.uploadId,s.items[0].resourceId,bytes())).rejects.toMatchObject({code:'ENOSPC'});
 expect((await u.get(s.uploadId)).items[0].status).toBe('incomplete');expect(await files.names()).toEqual([]);
 expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(3);
 expect((await make().receive(s.uploadId,s.items[0].resourceId,bytes())).received).toBe(1);
});
for(const committed of [false,true])it('reconciles receipt transaction '+(committed?'committed but acknowledgement lost':'rolled back after file rename'),async()=>{
 let armed=false;
 const proxy={query:(...args)=>db.pool.query(...args),connect:async()=>{
  const c=await db.pool.connect();let receipt=false;
  return {release:(...args)=>c.release(...args),query:async(sql,args)=>{
   if(String(sql).includes("SET status='received',storage_key="))receipt=true;
   if(armed&&receipt&&sql==='COMMIT'){armed=false;if(committed)await c.query(sql);throw Error('lost commit acknowledgement');}
   return c.query(sql,args);
  }};
 }};
 const u=make({pool:proxy}),s=await u.create(manifest());armed=true;
 await expect(u.receive(s.uploadId,s.items[0].resourceId,bytes())).rejects.toThrow('lost commit');
 const item=(await db.pool.query('SELECT * FROM upload_items WHERE id=$1',[s.items[0].resourceId])).rows[0];
 expect(item.attempt_id).toBeNull();expect(item.status).toBe(committed?'received':'incomplete');
 if(committed)expect(await files.exists(item.storage_key,3)).toBe(true);
 expect((await make().receive(s.uploadId,s.items[0].resourceId,bytes())).received).toBe(1);
});
it('restart removes a renamed orphan after a crash',async()=>{
 const u=make(),s=await u.create(manifest()),attempt=randomUUID(),name=attempt+'.bin';
 await db.pool.query("UPDATE upload_items SET attempt_id=$2,status='receiving' WHERE id=$1",[s.items[0].resourceId,attempt]);
 await files.receive(name,bytes(),3,new AbortController().signal);expect(await files.exists(name,3)).toBe(true);
 await u.recover();expect(await files.exists(name,3)).toBe(false);expect((await u.get(s.uploadId)).items[0].status).toBe('incomplete');
});
it('absolute cap, ready lifetime and tombstone retention have exact boundaries',async()=>{
 const u=make({config:readUploadConfig({UPLOAD_IDLE_MS:'10000',UPLOAD_ABSOLUTE_MS:'1000',UPLOAD_READY_MS:'2000',UPLOAD_METADATA_MS:'3000'})});
 const m=manifest(),s=await u.create(m);time+=1000;
 await expect(u.receive(s.uploadId,s.items[0].resourceId,bytes())).rejects.toThrow('expired');
 await u.cleanup();await expect(u.create(m)).rejects.toThrow('expired');
 time+=2999;await u.cleanup();expect((await u.get(s.uploadId)).status).toBe('expired');
 time++;await u.cleanup();await expect(u.get(s.uploadId)).rejects.toThrow('not found');expect((await u.create(m)).uploadId).not.toBe(s.uploadId);
 const r=await u.create(manifest());await u.receive(r.uploadId,r.items[0].resourceId,bytes());await u.finalize(r.uploadId);
 time+=1999;expect((await u.get(r.uploadId)).status).toBe('ready');time++;
 const results=await Promise.allSettled([u.finalize(r.uploadId),u.cleanup()]);expect(results[0].status).toBe('rejected');expect((await u.get(r.uploadId)).status).toBe('expired');
});
it('migration 004 preserves a populated 0.1.0 database exactly',async()=>{
 const old=isolatedDatabase();await old.setup();
 try{
  const dir=await mkdtemp(join(tmpdir(),'upload-upgrade-'));
  for(const n of await readdir('migrations'))if(/^00[1-3]_/.test(n))await copyFile(join('migrations',n),join(dir,n));
  expect((await migrate(old.pool,dir)).ok).toBe(true);
  const template=JSON.parse(await readFile('examples/srs-template.json','utf8'));
  // Seed only columns present in 001–003. The current registrar deliberately
  // requires the latest schema and cannot represent a historical deployment.
  const valid=validateTemplate(template);expect(valid.ok).toBe(true);
  const record=decompose(template,randomUUID),versionId=randomUUID();
  await old.pool.query('INSERT INTO templates(id,doc_key,name) VALUES($1,$2,$3)',[template.templateId,template.docKey,template.name]);
  await old.pool.query('INSERT INTO template_versions(id,template_id,version,definition_json,fingerprint) VALUES($1,$2,$3,$4,$5)',[versionId,template.templateId,template.version,JSON.stringify(template),valid.value.fingerprint]);
  await old.pool.query('INSERT INTO template_current(template_id,payload) VALUES($1,$2)',[template.templateId,JSON.stringify(record.payload)]);
  await old.pool.query('INSERT INTO template_snapshots(version_id,payload) VALUES($1,$2)',[versionId,JSON.stringify(record.payload)]);
  const ids=new Map([...record.formats,...record.schemas,...record.variables].map(r=>[r.id,randomUUID()]));
  for(const f of record.formats){
   await old.pool.query('INSERT INTO formats(id,template_id,key,position,payload) VALUES($1,$2,$3,$4,$5)',[f.id,template.templateId,f.key,f.position,JSON.stringify(f.payload)]);
   await old.pool.query('INSERT INTO format_versions(id,template_version_id,source_format_id,key,position,payload) VALUES($1,$2,$3,$4,$5,$6)',[ids.get(f.id),versionId,f.id,f.key,f.position,JSON.stringify(f.payload)]);
  }
  for(const s of record.schemas){
   await old.pool.query('INSERT INTO variable_schemas(id,template_id,format_id) VALUES($1,$2,$3)',[s.id,template.templateId,s.formatId]);
   await old.pool.query('INSERT INTO variable_schema_versions(id,template_version_id,source_schema_id,format_version_id) VALUES($1,$2,$3,$4)',[ids.get(s.id),versionId,s.id,s.formatId?ids.get(s.formatId):null]);
  }
  for(const v of record.variables){
   await old.pool.query('INSERT INTO variables(id,schema_id,parent_id,key,type_id,position,payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[v.id,v.schemaId,v.parentId,v.key,v.typeId,v.position,JSON.stringify(v.payload)]);
   await old.pool.query('INSERT INTO variable_versions(id,schema_version_id,source_variable_id,parent_version_id,key,type_id,position,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ids.get(v.id),ids.get(v.schemaId),v.id,v.parentId?ids.get(v.parentId):null,v.key,v.typeId,v.position,JSON.stringify(v.payload)]);
  }
  const input=JSON.parse(await readFile('examples/srs-request.json','utf8'));
  const prepared=prepareGeneration(valid.value,input);expect(prepared.ok).toBe(true);
  const job=randomUUID();await old.pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices) VALUES($1,$2,$3,$4,$5,$6)',[job,versionId,JSON.stringify(input),JSON.stringify(prepared.value),JSON.stringify(prepared.value.warnings),JSON.stringify(prepared.value.skippedContentIndices)]);
  const tables=(await old.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename<>'schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,JSON.stringify((await old.pool.query('SELECT * FROM "'+t+'" ORDER BY 1')).rows)])));
  const before=await snapshot();const uploadDir=await mkdtemp(join(tmpdir(),'upload-only-'));for(const n of await readdir('migrations'))if(/^00[1-4]_/.test(n))await copyFile(join('migrations',n),join(uploadDir,n));expect(await migrate(old.pool,uploadDir)).toMatchObject({ok:true,value:{applied:['004_upload_staging.sql']}});expect(await snapshot()).toEqual(before);
  expect(await migrate(old.pool)).toMatchObject({ok:true,value:{applied:['005_image_variable_type.sql','006_upload_job_claims.sql','007_job_processing.sql','008_link_variable_type.sql','009_area_ownership.sql','010_page_band_schemas.sql','011_section_ownership.sql','012_page_numbering.sql']}});
  const upgraded=await snapshot(),types=JSON.parse(upgraded.variable_types);
  for(const [id,code] of [[110004,'image'],[110005,'link'],[110006,'area']])expect(types.find(x=>x.id===id).code).toBe(code);
  // Later migrations intentionally add columns/masters; every historical row,
  // identifier and historical column must remain byte-for-byte equivalent.
  for(const table of tables){
   const original=JSON.parse(before[table]),rows=JSON.parse(upgraded[table]);
   const retained=table==='variable_types'?rows.filter(r=>![110004,110005,110006].includes(r.id)):rows;
   expect(retained).toHaveLength(original.length);
   expect(retained.map((r,i)=>Object.fromEntries(Object.keys(original[i]).map(k=>[k,r[k]])))).toEqual(original);
  }
  expect((await loadTemplate(old.pool,template.docKey)).ok).toBe(true);expect((await old.pool.query('SELECT id FROM generation_jobs WHERE id=$1',[job])).rowCount).toBe(1);
 }finally{await old.close();}
});
