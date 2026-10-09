import type {PoolClient} from 'pg';
import {validateTemplate} from '@flowdoc/core';
import {assemble,decompose,checkRecord} from './assembly.js';
import type {CurrentRecord} from './assembly.js';
import {OperationError} from '../errors.js';
export async function freshRecord(c:PoolClient,t:any):Promise<CurrentRecord>{
 let count=1;const probe=decompose(t,()=>String(count++));
 const ids=(await c.query<{id:string}>('SELECT uuidv7() AS id FROM generate_series(1,$1)',[probe.formats.length+probe.schemas.length+probe.variables.length])).rows;let i=0;
 return decompose(t,()=>ids[i++]!.id);
}
export async function readRecord(c:PoolClient,id:string,version=false):Promise<CurrentRecord>{
 const head=await c.query(version?'SELECT payload,0 AS revision FROM template_snapshots WHERE version_id=$1':'SELECT payload,revision FROM template_current WHERE template_id=$1',[id]);
 if(!head.rows.length)throw new OperationError('TEMPLATE_NOT_FOUND','template','Current or snapshot not found');
 const formats=(await c.query(version?'SELECT id,key,position,payload,owner_area_variable_version_id AS "ownerAreaVariableId",source_definition_id AS "sourceDefinitionId" FROM format_versions WHERE template_version_id=$1 ORDER BY position,id':'SELECT id,key,position,payload,owner_area_variable_id AS "ownerAreaVariableId",source_definition_id AS "sourceDefinitionId" FROM formats WHERE template_id=$1 ORDER BY position,id',[id])).rows;
 const schemas=(await c.query(version?'SELECT id,format_version_id AS "formatId" FROM variable_schema_versions WHERE template_version_id=$1 ORDER BY id':'SELECT id,format_id AS "formatId" FROM variable_schemas WHERE template_id=$1 ORDER BY id',[id])).rows;
 const variables=(await c.query(version?'SELECT v.id,v.schema_version_id AS "schemaId",v.parent_version_id AS "parentId",v.key,v.type_id AS "typeId",v.position,v.payload FROM variable_versions v JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE s.template_version_id=$1 ORDER BY v.position,v.id':'SELECT v.id,v.schema_id AS "schemaId",v.parent_id AS "parentId",v.key,v.type_id AS "typeId",v.position,v.payload FROM variables v JOIN variable_schemas s ON s.id=v.schema_id WHERE s.template_id=$1 ORDER BY v.position,v.id',[id])).rows;
 return {templateId:head.rows[0].payload.templateId,revision:head.rows[0].revision,payload:head.rows[0].payload,formats,schemas,variables};
}
export async function writeCurrent(c:PoolClient,r:CurrentRecord):Promise<void>{
 checkRecord(r);
 // Retain original creation times when replacing an ID-bearing current graph.
 const times=new Map<string,Date>();for(const row of (await c.query('SELECT id,created_at FROM formats WHERE template_id=$1 UNION ALL SELECT id,created_at FROM variable_schemas WHERE template_id=$1 UNION ALL SELECT v.id,v.created_at FROM variables v JOIN variable_schemas s ON s.id=v.schema_id WHERE s.template_id=$1',[r.templateId])).rows)times.set(row.id,row.created_at);
 await c.query('INSERT INTO template_current(template_id,payload) VALUES($1,$2) ON CONFLICT(template_id) DO UPDATE SET payload=$2,revision=template_current.revision+1,updated_at=now()',[r.templateId,JSON.stringify(r.payload)]);
 await c.query('DELETE FROM formats WHERE template_id=$1',[r.templateId]);await c.query('DELETE FROM variable_schemas WHERE template_id=$1',[r.templateId]);
 for(const f of r.formats)await c.query('INSERT INTO formats(id,template_id,key,position,payload,created_at,owner_area_variable_id,source_definition_id) VALUES($1,$2,$3,$4,$5,COALESCE($6,now()),$7,$8)',[f.id,r.templateId,f.key,f.position,JSON.stringify(f.payload),times.get(f.id)??null,f.ownerAreaVariableId??null,f.sourceDefinitionId??null]);
 for(const s of r.schemas)await c.query('INSERT INTO variable_schemas(id,template_id,format_id,created_at) VALUES($1,$2,$3,COALESCE($4,now()))',[s.id,r.templateId,s.formatId,times.get(s.id)??null]);
 for(const v of r.variables)await c.query('INSERT INTO variables(id,schema_id,parent_id,key,type_id,position,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,now()))',[v.id,v.schemaId,v.parentId,v.key,v.typeId,v.position,JSON.stringify(v.payload),times.get(v.id)??null]);
 await c.query('UPDATE templates SET name=$2,updated_at=now() WHERE id=$1',[r.templateId,r.payload.name]);
}
export async function writeSnapshot(c:PoolClient,r:CurrentRecord,versionId:string,legacy=false):Promise<void>{
 checkRecord(r);const rows=[...r.formats,...r.schemas,...r.variables],ids=(await c.query<{id:string}>('SELECT uuidv7() AS id FROM generate_series(1,$1)',[rows.length])).rows;
 const map=new Map(rows.map((row,i)=>[row.id,ids[i]!.id]));
 await c.query('INSERT INTO template_snapshots(version_id,payload) VALUES($1,$2)',[versionId,JSON.stringify(r.payload)]);
 for(const f of r.formats)await c.query('INSERT INTO format_versions(id,template_version_id,source_format_id,key,position,payload,owner_area_variable_version_id,source_definition_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[map.get(f.id),versionId,legacy?null:f.id,f.key,f.position,JSON.stringify(f.payload),f.ownerAreaVariableId?map.get(f.ownerAreaVariableId):null,f.sourceDefinitionId??null]);
 for(const s of r.schemas)await c.query('INSERT INTO variable_schema_versions(id,template_version_id,source_schema_id,format_version_id) VALUES($1,$2,$3,$4)',[map.get(s.id),versionId,legacy?null:s.id,s.formatId?map.get(s.formatId):null]);
 for(const v of r.variables)await c.query('INSERT INTO variable_versions(id,schema_version_id,source_variable_id,parent_version_id,key,type_id,position,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[map.get(v.id),map.get(v.schemaId),legacy?null:v.id,v.parentId?map.get(v.parentId):null,v.key,v.typeId,v.position,JSON.stringify(v.payload)]);
}
export async function backfill(c:PoolClient):Promise<void>{
 const rows=(await c.query('SELECT v.id,v.template_id,v.version,v.definition_json,v.fingerprint FROM template_versions v LEFT JOIN template_snapshots s ON s.version_id=v.id WHERE s.version_id IS NULL ORDER BY v.template_id,v.version')).rows;
 for(const v of rows){const valid=validateTemplate(v.definition_json);if(!valid.ok||valid.value.fingerprint!==v.fingerprint)throw new OperationError('STORAGE_FAILED','migration','Legacy template failed validation');const r=await freshRecord(c,valid.value.definition);await writeSnapshot(c,r,v.id,true);}
 for(const t of (await c.query('SELECT t.id,v.definition_json FROM templates t JOIN LATERAL (SELECT definition_json FROM template_versions WHERE template_id=t.id ORDER BY version DESC LIMIT 1) v ON true LEFT JOIN template_current c ON c.template_id=t.id WHERE c.template_id IS NULL')).rows)await writeCurrent(c,await freshRecord(c,t.definition_json));
}
export async function verifySnapshot(c:PoolClient,id:string,version:number,fingerprint:string){const valid=validateTemplate(assemble(await readRecord(c,id,true),version));if(!valid.ok||valid.value.fingerprint!==fingerprint)throw new OperationError('STORAGE_FAILED','template','Stored snapshot failed validation');return valid.value;}
