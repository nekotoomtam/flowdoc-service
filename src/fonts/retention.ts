import {LEGACY_SARABUN} from './legacy.js';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {fontError} from './repository.js';
export interface FontTuple {releaseId:string;weight:number;style:'normal'|'italic'}
export interface ReferenceSet {id:string;definitionFingerprint:string;bindings:FontTuple[];legacyBindings:{id:string;sha256:string;origin:'verified_legacy'}[]}
export const tupleKey=(f:FontTuple)=>JSON.stringify([f.releaseId,f.weight,f.style]);
export function fontTuples(definition:any):FontTuple[]{
 const tuples=new Map<string,FontTuple>();
 if(definition.schemaVersion===2)for(const s of Object.values(definition.styles) as any[])if(s.font?.kind==='library'){
  const {releaseId,weight,style}=s.font,t={releaseId,weight,style};tuples.set(tupleKey(t),t);
 }
 return [...tuples.values()].sort((a,b)=>tupleKey(a).localeCompare(tupleKey(b)));
}
export async function readReferences(c:Pick<PoolClient,'query'>,templateId:string,revision:number,versionId?:string):Promise<ReferenceSet|null>{
 if(!(await c.query("SELECT to_regclass('font_reference_sets') AS present")).rows[0]?.present)return null;
 const r=(await c.query(versionId?'SELECT * FROM font_reference_sets WHERE version_id=$1':"SELECT * FROM font_reference_sets WHERE template_id=$1 AND revision=$2 AND owner_kind='draft_revision'",versionId?[versionId]:[templateId,revision])).rows[0];
 if(!r)return null;
 const bindings=(await c.query('SELECT release_id AS "releaseId",weight,style FROM font_reference_bindings WHERE reference_set_id=$1',[r.id])).rows;
 return {id:r.id,definitionFingerprint:r.definition_fingerprint,bindings,legacyBindings:r.legacy_bindings};
}
export async function writeReferences(c:PoolClient,definition:any,definitionFingerprint:string,revision:number,previous:ReferenceSet|null,versionId?:string,additionalInherited:ReferenceSet[]=[]){
 if(!(await c.query("SELECT to_regclass('font_reference_sets') AS present")).rows[0]?.present){if(definition.schemaVersion===2)fontError('FONT_CHECK_UNAVAILABLE');return null;}
 const tuples=fontTuples(definition),ids=[...new Set(tuples.map(t=>t.releaseId))].sort();
 // State transitions and selection serialize on the same release rows.
 if(ids.length)await c.query('SELECT id FROM font_releases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
 const id=randomUUID();await c.query('INSERT INTO font_reference_sets(id,owner_kind,template_id,version_id,revision,definition_fingerprint,legacy_bindings) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,versionId?'template_version':'draft_revision',definition.templateId,versionId??null,versionId?null:revision,definitionFingerprint,JSON.stringify(definition.schemaVersion===1?LEGACY_SARABUN:[])]);
 for(const t of tuples){
  const source=[...(previous?[previous]:[]),...additionalInherited].find(r=>r.bindings.some(b=>tupleKey(b)===tupleKey(t))),inherited=!!source;
  const active=(await c.query("SELECT 1 FROM font_releases r JOIN font_faces f ON f.release_id=r.id WHERE r.id=$1 AND r.state='active' AND r.ever_activated_at IS NOT NULL AND f.approved_weight=$2 AND f.style=$3",[t.releaseId,t.weight,t.style])).rowCount;
  if(!inherited&&!active)continue;
  await c.query('INSERT INTO font_reference_bindings(reference_set_id,release_id,weight,style,origin,source_reference_set_id,source_binding_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,t.releaseId,t.weight,t.style,inherited?'inherited':'active_selection',inherited?source!.id:null,inherited?tupleKey(t):null]);
 }
 return readReferences(c,definition.templateId,revision,versionId);
}
export function verifyReferences(definition:any,fingerprint:string,refs:ReferenceSet|null){
 if(definition.schemaVersion===2&&(!refs||refs.definitionFingerprint!==fingerprint))fontError('FONT_CHECK_UNAVAILABLE');
}
