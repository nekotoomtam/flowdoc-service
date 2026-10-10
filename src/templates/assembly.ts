import type {TemplateDefinition} from '@flowdoc/core';
import {OperationError} from '../errors.js';
export type Json = Record<string, any>;
export interface SectionRow {id:string;sourceDefinitionId:string;key:string;label?:string;position:number;payload:Json}
export interface FormatRow {sectionId?:string|null;id:string;key:string;position:number;payload:Json;ownerAreaVariableId?:string|null;sourceDefinitionId?:string|null}
export interface SchemaRow {sectionId?:string|null;id:string;formatId:string|null;scope?:'global'|'section'|'format'|'header'|'footer'}
export const schemaScope=(s:SchemaRow)=>s.scope??(s.formatId===null?'global':'format');
export interface VariableRow {id:string;schemaId:string;parentId:string|null;key:string;typeId:number;position:number;payload:Json}
export interface CurrentRecord {sections?:SectionRow[];templateId:string;revision:number;payload:Json;formats:FormatRow[];schemas:SchemaRow[];variables:VariableRow[]}
const codes:Record<number,string>={110001:'string',110002:'object',110003:'array',110004:'image',110005:'link',110006:'area'};
const typeIds:Record<string,number>={string:110001,array:110003,image:110004,link:110005,area:110006};
const invalid=(path:string):never=>{throw new OperationError('INVALID_DATA',path,'Invalid current record structure');};
export function decompose(input:TemplateDefinition,id:()=>string):CurrentRecord {
 const t:Json=structuredClone(input),{formats,globalSchema,version,areaFormats,...payload}=t;
 const record:CurrentRecord={templateId:t.templateId,revision:0,payload,formats:[],schemas:[],variables:[]};
 function schema(s:any,formatId:string|null,scope:NonNullable<SchemaRow['scope']>=formatId===null?'global':'format',sectionId:string|null=null){const sid=id();record.schemas.push({id:sid,formatId,scope,...((t.nodeModelVersion===15||t.nodeModelVersion===16)?{sectionId}:{})});
  function fields(fields:Json,parentId:string|null){Object.entries(fields).forEach(([key,f],position)=>{const vid=id(),{type,items,...rest}=f;if(!Object.hasOwn(typeIds,type))invalid('type');record.variables.push({id:vid,schemaId:sid,parentId,key,typeId:typeIds[type]!,position,payload:rest});if(type==='array')fieldsChild(items.fields,vid);});}
  const fieldsChild=(f:Json,p:string)=>fields(f,p);fields(s.fields,null);
 }
 for(const k of ['header','footer'] as const)if(t.nodeModelVersion===14&&t[k]){schema(t[k]!.inputSchema,null,k);delete (record.payload[k] as Json).inputSchema;}
 schema(globalSchema,null);
 const addFormats=(formats:Json,sectionId:string|null=null)=>Object.entries(formats).forEach(([key,f],position)=>{const fid=id(),{inputSchema,...rest}=f;record.formats.push({id:fid,key,position,payload:rest,...((t.nodeModelVersion===15||t.nodeModelVersion===16)?{sectionId}:{})});schema(inputSchema,fid,'format',sectionId);});
 if((t.nodeModelVersion===15||t.nodeModelVersion===16)){delete record.payload.sections;record.sections=[];t.sections.forEach((s:Json,position:number)=>{const sid=id(),{id:sourceDefinitionId,key,label,inputSchema,formats,...rest}=s;record.sections!.push({id:sid,sourceDefinitionId,key,...(label===undefined?{}:{label}),position,payload:rest});schema(inputSchema,null,'section',sid);addFormats(formats,sid);for(const k of ['header','footer'] as const)if(rest[k]){schema(rest[k].inputSchema,null,k,sid);delete rest[k].inputSchema;}});}else addFormats(formats);
 const owners=new Map(record.variables.filter(v=>v.typeId===110006).map(v=>[v.payload.areaId,v.id]));
 Object.entries(areaFormats??{}).forEach(([sourceDefinitionId,f]:[string,any],position)=>{const fid=id(),{key,ownerAreaId,inputSchema,...rest}=f,owner=owners.get(ownerAreaId);if(!owner)invalid('ownerAreaId');record.formats.push({id:fid,key,position,payload:rest,ownerAreaVariableId:owner!,sourceDefinitionId,...((t.nodeModelVersion===15||t.nodeModelVersion===16)?{sectionId:record.schemas.find(s=>s.id===record.variables.find(v=>v.id===owner)!.schemaId)!.sectionId??null}:{})});schema(inputSchema,fid,'format',record.formats.at(-1)!.sectionId??null);});return record;
}
export function checkRecord(r:CurrentRecord):void {
 if(!r||typeof r.templateId!=='string'||!r.payload||r.payload.templateId!==r.templateId||!Array.isArray(r.formats)||!Array.isArray(r.schemas)||!Array.isArray(r.variables))invalid('record');
 const ids=new Set<string>();for(const row of [...(r.sections??[]),...r.formats,...r.schemas,...r.variables]){if(typeof row.id!=='string'||!row.id||ids.has(row.id))invalid('id');ids.add(row.id);}
 const fmt=new Map(r.formats.map(f=>[f.id,f])),schemas=new Map(r.schemas.map(s=>[s.id,s])),vars=new Map(r.variables.map(v=>[v.id,v]));
 const sections=new Map((r.sections??[]).map(s=>[s.id,s]));
 const modern=(r.payload.nodeModelVersion===15||r.payload.nodeModelVersion===16), sectionKeys=new Set<string>(),sectionSources=new Set<string>(),positions=new Set<number>();
 if(modern?(!Array.isArray(r.sections)||!r.sections.length||Object.hasOwn(r.payload,'sections')):r.sections?.length)invalid('sections');
 for(const s of r.sections??[]){if(!s.key||sectionKeys.has(s.key)||!s.sourceDefinitionId||sectionSources.has(s.sourceDefinitionId)||!Number.isInteger(s.position)||s.position<0||positions.has(s.position)||!s.payload||['id','key','label','inputSchema','formats'].some(k=>Object.hasOwn(s.payload,k)))invalid('sections');sectionKeys.add(s.key);sectionSources.add(s.sourceDefinitionId);positions.add(s.position);}
 const formatKeys=new Set<string>();for(const f of r.formats){const scope=JSON.stringify([f.sectionId??null,f.ownerAreaVariableId??null,f.key]);if(!f.key||formatKeys.has(scope)||!Number.isInteger(f.position)||f.position<0||!f.payload)invalid('formats');formatKeys.add(scope);if(f.sectionId!=null&&!sections.has(f.sectionId))invalid('format.sectionId');if(modern&&f.ownerAreaVariableId==null&&f.sectionId==null)invalid('format.sectionId');}
 const owners=new Set<string>(),ownerKey=(scope:string,sectionId:string|null|undefined,formatId:string|null)=>JSON.stringify([scope,sectionId??null,formatId]);
 for(const s of r.schemas){const scope=schemaScope(s);if(!['global','section','format','header','footer'].includes(scope)||(scope==='format'?(s.formatId===null||!fmt.has(s.formatId)):s.formatId!==null))invalid('schemas');if(s.sectionId!=null&&!sections.has(s.sectionId))invalid('schemas.sectionId');if(scope==='global'&&s.sectionId!=null||scope==='section'&&(!modern||s.sectionId==null)||modern&&['header','footer'].includes(scope)&&s.sectionId==null)invalid('schemas.sectionId');if(s.formatId&&(s.sectionId??null)!==(fmt.get(s.formatId)!.sectionId??null))invalid('schemas.owner');const key=ownerKey(scope,s.sectionId,s.formatId);if(owners.has(key))invalid('schemas');owners.add(key);if(['header','footer'].includes(scope)&&!(modern?sections.get(s.sectionId!)?.payload[scope]:r.payload.nodeModelVersion===14&&r.payload[scope]))invalid('schemas');}
 if(!owners.has(ownerKey('global',null,null))||r.formats.some(f=>!owners.has(ownerKey('format',f.sectionId,f.id))))invalid('schemas');
 for(const sec of r.sections??[]){if(!owners.has(ownerKey('section',sec.id,null)))invalid('schemas');for(const k of ['header','footer'])if(sec.payload[k]&&(!owners.has(ownerKey(k,sec.id,null))||Object.hasOwn(sec.payload[k],'inputSchema')))invalid('schemas');}
 for(const k of ['header','footer'])if(r.payload[k]&&(modern||!owners.has(ownerKey(k,null,null))||Object.hasOwn(r.payload[k],'inputSchema')))invalid('schemas');

 const names=new Set();for(const v of r.variables){if(!schemas.has(v.schemaId)||typeof v.key!=='string'||!v.key||v.key.includes('.')||!codes[v.typeId]||!Number.isInteger(v.position)||v.position<0||!v.payload)invalid('variables');const name=JSON.stringify([v.schemaId,v.parentId,v.key]);if(names.has(name))invalid('key');names.add(name);
  if(v.typeId===110006&&(r.payload.nodeModelVersion<11||v.parentId!==null||typeof v.payload.areaId!=='string'||!v.payload.areaId))invalid('area');
  if(v.typeId===110002)invalid('type'); // Object is an envelope/item, not a supported arbitrary field.
  if(v.parentId!==null){const p=vars.get(v.parentId);if(!p||p.schemaId!==v.schemaId||p.typeId!==110003||p.parentId!==null||![110001,110005,...(r.payload.nodeModelVersion>=10?[110004]:[])].includes(v.typeId))invalid('parent');}
  const seen=new Set([v.id]);let p=v.parentId;while(p!==null){if(seen.has(p))invalid('cycle');seen.add(p);p=vars.get(p)?.parentId??null;}
  for(const reserved of ['id','key','type','items','fields','schemaId','parentId'])if(Object.hasOwn(v.payload,reserved))invalid('payload');
 }
 const authored=new Set<string>(),areas=new Set<string>();
 for(const v of r.variables)if(v.typeId===110006){if(areas.has(v.payload.areaId))invalid('areaId');areas.add(v.payload.areaId);const parent=schemas.get(v.schemaId)!;if(parent.formatId&&fmt.get(parent.formatId)?.ownerAreaVariableId)invalid('nestedArea');}
 for(const f of r.formats){if(f.ownerAreaVariableId!=null){const owner=vars.get(f.ownerAreaVariableId);if(r.payload.nodeModelVersion<11||!owner||owner.typeId!==110006||typeof f.sourceDefinitionId!=='string'||!f.sourceDefinitionId||authored.has(f.sourceDefinitionId))invalid('formatOwner');authored.add(f.sourceDefinitionId!);if((f.sectionId??null)!==(schemas.get(owner!.schemaId)!.sectionId??null))invalid('area.sectionId');}else if(f.sourceDefinitionId!=null)invalid('formatOwner');}
 for(const k of ['globalSchema','formats','areaFormats','version'])if(Object.hasOwn(r.payload,k))invalid('payload');
 for(const f of r.formats)if(['inputSchema','key','ownerAreaId'].some(k=>Object.hasOwn(f.payload,k)))invalid('formats');
}
export function assemble(r:CurrentRecord,version:number):TemplateDefinition {
 checkRecord(r);
 const schemasByFormat=new Map(r.schemas.filter(s=>s.formatId!==null).map(s=>[s.formatId,s])),varsById=new Map(r.variables.map(v=>[v.id,v]));
 const groups=new Map<string,VariableRow[]>();for(const v of r.variables){const k=JSON.stringify([v.schemaId,v.parentId]),g=groups.get(k)??[];g.push(v);groups.set(k,g);}for(const g of groups.values())g.sort((a,b)=>a.position-b.position);
 function schema(s:SchemaRow){function fields(parentId:string|null):Json {const out:Json=Object.create(null);for(const v of groups.get(JSON.stringify([s.id,parentId]))??[]){out[v.key]={...structuredClone(v.payload),type:codes[v.typeId]};if(v.typeId===110003)out[v.key].items={type:'object',fields:fields(v.id)};}return out;}return {type:'object',fields:fields(null)};}
 const formats:Json=Object.create(null),areaFormats:Json=Object.create(null),bySection=new Map<string,Json>();for(const f of [...r.formats].sort((a,b)=>a.position-b.position)){const value={...structuredClone(f.payload),inputSchema:schema(schemasByFormat.get(f.id)!)};if(f.ownerAreaVariableId!=null)areaFormats[f.sourceDefinitionId!]={...value,key:f.key,ownerAreaId:varsById.get(f.ownerAreaVariableId)!.payload.areaId};else if(f.sectionId!=null){const group=bySection.get(f.sectionId)??Object.create(null);group[f.key]=value;bySection.set(f.sectionId,group);}else formats[f.key]=value;}

 const payload=structuredClone(r.payload);
 // Examples belong to the published envelope, not to an earlier draft import.
 if(Array.isArray(payload.examples))for(const e of payload.examples)if(e?.request&&typeof e.request==='object')e.request.version=version;
 for(const k of ['header','footer'] as const)if(payload[k])payload[k]={...payload[k],inputSchema:schema(r.schemas.find(s=>schemaScope(s)===k)!)};
 if((r.payload.nodeModelVersion===15||r.payload.nodeModelVersion===16))payload.sections=[...(r.sections??[])].sort((a,b)=>a.position-b.position).map(s=>{const p=structuredClone(s.payload);for(const k of ['header','footer'])if(p[k])p[k].inputSchema=schema(r.schemas.find(v=>v.sectionId===s.id&&schemaScope(v)===k)!);return {...p,id:s.sourceDefinitionId,key:s.key,...(s.label===undefined?{}:{label:s.label}),inputSchema:schema(r.schemas.find(v=>v.sectionId===s.id&&schemaScope(v)==='section')!),formats:bySection.get(s.id)??{}};});
 return {...payload,templateId:r.templateId,version,globalSchema:schema(r.schemas.find(s=>schemaScope(s)==='global')!),...((r.payload.nodeModelVersion===15||r.payload.nodeModelVersion===16)?{}:{formats}),...(Object.keys(areaFormats).length?{areaFormats}:{})} as TemplateDefinition;
}

export function normalizeAreaDeletions(existing:CurrentRecord,incoming:CurrentRecord):CurrentRecord {
 const out=structuredClone(incoming),remaining=new Set(out.variables.map(v=>v.id)),removed=existing.variables.filter(v=>v.typeId===110006&&!remaining.has(v.id));
 const ids=new Set(removed.map(v=>v.id)),authored=new Set(removed.map(v=>v.payload.areaId));
 const formats=new Set(existing.formats.filter(f=>f.ownerAreaVariableId&&ids.has(f.ownerAreaVariableId)).map(f=>f.id));
 const schemas=new Set(existing.schemas.filter(s=>s.formatId&&formats.has(s.formatId)).map(s=>s.id));
 out.formats=out.formats.filter(f=>!formats.has(f.id));out.schemas=out.schemas.filter(s=>!schemas.has(s.id));out.variables=out.variables.filter(v=>!schemas.has(v.schemaId));
 const fragments=out.formats.map(f=>f.payload.fragment);
 for(const s of out.sections??[])if(s.payload.source?.kind==='authored')fragments.push(s.payload.source.fragment);
 if([12,13,14].includes(out.payload.nodeModelVersion)&&Array.isArray(out.payload.sections))for(const s of out.payload.sections)if(s?.source?.kind==='authored')fragments.push(s.source.fragment);
 for(const fragment of fragments){if(!fragment||!fragment.nodes)continue;const deleted=new Set<string>();for(const [id,n] of Object.entries(fragment.nodes) as [string,any][])if(n?.type==='area'&&authored.has(n.props?.areaId)){delete fragment.nodes[id];deleted.add(id);}if(Array.isArray(fragment.rootIds))fragment.rootIds=fragment.rootIds.filter((id:string)=>!deleted.has(id));for(const n of Object.values(fragment.nodes) as any[])if(Array.isArray(n.childIds))n.childIds=n.childIds.filter((id:string)=>!deleted.has(id));}
 return out;
}

export function normalizeSectionDeletions(existing:CurrentRecord,incoming:CurrentRecord):CurrentRecord {
 const out=structuredClone(incoming),remaining=new Set((out.sections??[]).map(s=>s.id)),removed=new Set((existing.sections??[]).filter(s=>!remaining.has(s.id)).map(s=>s.id));
 const schemas=new Set(existing.schemas.filter(s=>s.sectionId&&removed.has(s.sectionId)).map(s=>s.id));
 out.formats=out.formats.filter(f=>!f.sectionId||!removed.has(f.sectionId));out.schemas=out.schemas.filter(s=>!schemas.has(s.id));out.variables=out.variables.filter(v=>!schemas.has(v.schemaId));return out;
}
