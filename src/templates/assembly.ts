import type {TemplateDefinition} from '@flowdoc/core';
import {OperationError} from '../errors.js';
export type Json = Record<string, any>;
export interface FormatRow {id:string;key:string;position:number;payload:Json;ownerAreaVariableId?:string|null;sourceDefinitionId?:string|null}
export interface SchemaRow {id:string;formatId:string|null}
export interface VariableRow {id:string;schemaId:string;parentId:string|null;key:string;typeId:number;position:number;payload:Json}
export interface CurrentRecord {templateId:string;revision:number;payload:Json;formats:FormatRow[];schemas:SchemaRow[];variables:VariableRow[]}
const codes:Record<number,string>={110001:'string',110002:'object',110003:'array',110004:'image',110005:'link',110006:'area'};
const typeIds:Record<string,number>={string:110001,array:110003,image:110004,link:110005,area:110006};
const invalid=(path:string):never=>{throw new OperationError('INVALID_DATA',path,'Invalid current record structure');};
export function decompose(input:TemplateDefinition,id:()=>string):CurrentRecord {
 const t=structuredClone(input),{formats,globalSchema,version,areaFormats,...payload}=t;
 const record:CurrentRecord={templateId:t.templateId,revision:0,payload,formats:[],schemas:[],variables:[]};
 function schema(s:any,formatId:string|null){const sid=id();record.schemas.push({id:sid,formatId});
  function fields(fields:Json,parentId:string|null){Object.entries(fields).forEach(([key,f],position)=>{const vid=id(),{type,items,...rest}=f;if(!Object.hasOwn(typeIds,type))invalid('type');record.variables.push({id:vid,schemaId:sid,parentId,key,typeId:typeIds[type]!,position,payload:rest});if(type==='array')fieldsChild(items.fields,vid);});}
  const fieldsChild=(f:Json,p:string)=>fields(f,p);fields(s.fields,null);
 }
 schema(globalSchema,null);Object.entries(formats).forEach(([key,f],position)=>{const fid=id(),{inputSchema,...rest}=f;record.formats.push({id:fid,key,position,payload:rest});schema(inputSchema,fid);});
 const owners=new Map(record.variables.filter(v=>v.typeId===110006).map(v=>[v.payload.areaId,v.id]));
 Object.entries(areaFormats??{}).forEach(([sourceDefinitionId,f],position)=>{const fid=id(),{key,ownerAreaId,inputSchema,...rest}=f,owner=owners.get(ownerAreaId);if(!owner)invalid('ownerAreaId');record.formats.push({id:fid,key,position,payload:rest,ownerAreaVariableId:owner!,sourceDefinitionId});schema(inputSchema,fid);});return record;
}
export function checkRecord(r:CurrentRecord):void {
 if(!r||typeof r.templateId!=='string'||!r.payload||r.payload.templateId!==r.templateId||!Array.isArray(r.formats)||!Array.isArray(r.schemas)||!Array.isArray(r.variables))invalid('record');
 const ids=new Set<string>();for(const row of [...r.formats,...r.schemas,...r.variables]){if(typeof row.id!=='string'||!row.id||ids.has(row.id))invalid('id');ids.add(row.id);}
 const fmt=new Map(r.formats.map(f=>[f.id,f])),schemas=new Map(r.schemas.map(s=>[s.id,s])),vars=new Map(r.variables.map(v=>[v.id,v]));
 const formatKeys=new Set<string>();for(const f of r.formats){const scope=JSON.stringify([f.ownerAreaVariableId??null,f.key]);if(!f.key||formatKeys.has(scope)||!Number.isInteger(f.position)||f.position<0||!f.payload)invalid('formats');formatKeys.add(scope);}
 const owners=new Set();for(const s of r.schemas){if((s.formatId!==null&&!fmt.has(s.formatId))||owners.has(s.formatId))invalid('schemas');owners.add(s.formatId);}if(!owners.has(null)||r.schemas.length!==r.formats.length+1)invalid('schemas');
 const names=new Set();for(const v of r.variables){if(!schemas.has(v.schemaId)||typeof v.key!=='string'||!v.key||v.key.includes('.')||!codes[v.typeId]||!Number.isInteger(v.position)||v.position<0||!v.payload)invalid('variables');const name=JSON.stringify([v.schemaId,v.parentId,v.key]);if(names.has(name))invalid('key');names.add(name);
  if(v.typeId===110006&&(r.payload.nodeModelVersion<11||v.parentId!==null||typeof v.payload.areaId!=='string'||!v.payload.areaId))invalid('area');
  if(v.typeId===110002)invalid('type'); // Object is an envelope/item, not a supported arbitrary field.
  if(v.parentId!==null){const p=vars.get(v.parentId);if(!p||p.schemaId!==v.schemaId||p.typeId!==110003||p.parentId!==null||![110001,110005,...(r.payload.nodeModelVersion>=10?[110004]:[])].includes(v.typeId))invalid('parent');}
  const seen=new Set([v.id]);let p=v.parentId;while(p!==null){if(seen.has(p))invalid('cycle');seen.add(p);p=vars.get(p)?.parentId??null;}
  for(const reserved of ['id','key','type','items','fields','schemaId','parentId'])if(Object.hasOwn(v.payload,reserved))invalid('payload');
 }
 const authored=new Set<string>(),areas=new Set<string>();
 for(const v of r.variables)if(v.typeId===110006){if(areas.has(v.payload.areaId))invalid('areaId');areas.add(v.payload.areaId);const parent=schemas.get(v.schemaId)!;if(parent.formatId&&fmt.get(parent.formatId)?.ownerAreaVariableId)invalid('nestedArea');}
 for(const f of r.formats){if(f.ownerAreaVariableId!=null){const owner=vars.get(f.ownerAreaVariableId);if(r.payload.nodeModelVersion<11||!owner||owner.typeId!==110006||typeof f.sourceDefinitionId!=='string'||!f.sourceDefinitionId||authored.has(f.sourceDefinitionId))invalid('formatOwner');authored.add(f.sourceDefinitionId!);}else if(f.sourceDefinitionId!=null)invalid('formatOwner');}
 for(const k of ['globalSchema','formats','areaFormats','version'])if(Object.hasOwn(r.payload,k))invalid('payload');
 for(const f of r.formats)if(['inputSchema','key','ownerAreaId'].some(k=>Object.hasOwn(f.payload,k)))invalid('formats');
}
export function assemble(r:CurrentRecord,version:number):TemplateDefinition {
 checkRecord(r);
 function schema(s:SchemaRow){function fields(parentId:string|null):Json {const out:Json=Object.create(null);for(const v of r.variables.filter(v=>v.schemaId===s.id&&v.parentId===parentId).sort((a,b)=>a.position-b.position)){out[v.key]={...structuredClone(v.payload),type:codes[v.typeId]};if(v.typeId===110003)out[v.key].items={type:'object',fields:fields(v.id)};}return out;}return {type:'object',fields:fields(null)};}
 const formats:Json=Object.create(null),areaFormats:Json=Object.create(null);for(const f of [...r.formats].sort((a,b)=>a.position-b.position)){const value={...structuredClone(f.payload),inputSchema:schema(r.schemas.find(s=>s.formatId===f.id)!)};if(f.ownerAreaVariableId!=null)areaFormats[f.sourceDefinitionId!]={...value,key:f.key,ownerAreaId:r.variables.find(v=>v.id===f.ownerAreaVariableId)!.payload.areaId};else formats[f.key]=value;}
 const payload=structuredClone(r.payload);
 // Examples belong to the published envelope, not to an earlier draft import.
 if(Array.isArray(payload.examples))for(const e of payload.examples)if(e?.request&&typeof e.request==='object')e.request.version=version;
 return {...payload,templateId:r.templateId,version,globalSchema:schema(r.schemas.find(s=>s.formatId===null)!),formats,...(Object.keys(areaFormats).length?{areaFormats}:{})} as TemplateDefinition;
}

export function normalizeAreaDeletions(existing:CurrentRecord,incoming:CurrentRecord):CurrentRecord {
 const out=structuredClone(incoming),remaining=new Set(out.variables.map(v=>v.id)),removed=existing.variables.filter(v=>v.typeId===110006&&!remaining.has(v.id));
 const ids=new Set(removed.map(v=>v.id)),authored=new Set(removed.map(v=>v.payload.areaId));
 const formats=new Set(existing.formats.filter(f=>f.ownerAreaVariableId&&ids.has(f.ownerAreaVariableId)).map(f=>f.id));
 const schemas=new Set(existing.schemas.filter(s=>s.formatId&&formats.has(s.formatId)).map(s=>s.id));
 out.formats=out.formats.filter(f=>!formats.has(f.id));out.schemas=out.schemas.filter(s=>!schemas.has(s.id));out.variables=out.variables.filter(v=>!schemas.has(v.schemaId));
 for(const f of out.formats){const fragment=f.payload.fragment;if(!fragment||!fragment.nodes)continue;const deleted=new Set<string>();for(const [id,n] of Object.entries(fragment.nodes) as [string,any][])if(n?.type==='area'&&authored.has(n.props?.areaId)){delete fragment.nodes[id];deleted.add(id);}if(Array.isArray(fragment.rootIds))fragment.rootIds=fragment.rootIds.filter((id:string)=>!deleted.has(id));for(const n of Object.values(fragment.nodes) as any[])if(Array.isArray(n.childIds))n.childIds=n.childIds.filter((id:string)=>!deleted.has(id));}
 return out;
}
