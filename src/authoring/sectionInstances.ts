import {randomUUID} from 'node:crypto';
import {OperationError} from '../errors.js';
type Json=Record<string,any>;
const fail=(code:string,path:string):never=>{throw new OperationError(code,path,code);};
function visit(value:any,fn:(v:Json)=>void){if(Array.isArray(value))value.forEach(v=>visit(v,fn));else if(value&&typeof value==='object'){fn(value);Object.values(value).forEach(v=>visit(v,fn));}}
export function nextLabel(base:string,sections:Json[]):string {let n=1;while(sections.some(s=>s.label===base+n))n++;return base+n;}

/** Pure copy; final Core validation and atomic persistence belong to the caller. */
export function importSections(target:Json,source:Json,selected:string[],sourceRevision:number,before:string|null,renames:Json={},preserveGlobals=false){
 if(source.nodeModelVersion!==19||target.nodeModelVersion!==19)fail('VERSION_MISMATCH','nodeModelVersion');
 if(source.schemaVersion!==target.schemaVersion)fail('VERSION_MISMATCH','schemaVersion');
 if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!source.sections.some((s:Json)=>s.id===id)))fail('INVALID_DATA','sourceSectionIds');
 if(before!==null&&!target.sections.some((s:Json)=>s.id===before))fail('INVALID_DATA','beforeSectionId');
 if(!renames||typeof renames!=='object'||Array.isArray(renames)||Object.keys(renames).some(k=>!selected.includes(k)))fail('INVALID_DATA','globalFieldRenames');
 const definition=structuredClone(target),sectionIdMap:Record<string,string>=Object.fromEntries(selected.map(id=>[id,randomUUID()])),inserted:Json[]=[],areaIdMap:Record<string,string>={};
 definition.areaFormats??={};
 for(const id of selected){
  const original=source.sections.find((s:Json)=>s.id===id),s=structuredClone(original),areas=new Set<string>();
  visit(s,v=>{if(v.type==='area'&&typeof v.areaId==='string')areas.add(v.areaId);if(v.type==='area'&&v.props?.areaId)areas.add(v.props.areaId);});
  const owned=Object.entries(source.areaFormats??{}).filter(([,f]:any)=>areas.has(f.ownerAreaId)).map(([fid,f])=>({fid,value:structuredClone(f)}));
  const graph=[s,...owned.map(f=>f.value)],globals=new Set<string>(),styleIds=new Set<string>();
  for(const [key,field] of Object.entries(source.globalSchema.fields) as [string,any][])if(field.type==='area'&&areas.has(field.areaId))globals.add(key);
  visit(graph,v=>{
   if(v.scope==='global'&&typeof v.key==='string')globals.add(v.key);
   if(v.type==='reference'&&v.targetSectionId!==undefined&&!selected.includes(v.targetSectionId))fail('SECTION_DEPENDENCY_OUTSIDE_SELECTION','targetSectionId');
   if(typeof v.textStyleId==='string')styleIds.add(v.textStyleId);
   if(typeof v.baseTextStyleId==='string')styleIds.add(v.baseTextStyleId);
  });
  const rename=renames[id]??{};
  if(!rename||typeof rename!=='object'||Array.isArray(rename)||Object.keys(rename).some(k=>!globals.has(k)))fail('INVALID_DATA','globalFieldRenames');
  const globalMap=new Map<string,string>();
  for(const key of globals){
   if(preserveGlobals){globalMap.set(key,key);continue;}
   const dest=Object.hasOwn(rename,key)?rename[key]:key;
   if(typeof dest!=='string'||!dest.trim()||dest.includes('.')||Object.hasOwn(s.inputSchema.fields,dest)||[...globalMap.values()].includes(dest))fail('IMPORT_BINDING_COLLISION','globalFieldRenames');
   const field=source.globalSchema.fields[key];if(!field)fail('INVALID_DATA','globalSchema');
   // Global Areas are also copied under this new Section's ownership.
   s.inputSchema.fields[dest]=structuredClone(field);globalMap.set(key,dest);
   if(field.type==='area'){
    areas.add(field.areaId);
    for(const [fid,f] of Object.entries(source.areaFormats??{}) as [string,any][])if(f.ownerAreaId===field.areaId&&!owned.some(o=>o.fid===fid)){const value=structuredClone(f);owned.push({fid,value});visit(value,v=>{if(v.scope==='global'&&typeof v.key==='string')globals.add(v.key);});}
   }
  }
  // Collect dependencies introduced by global Area formats as well.
  visit(owned,v=>{if(typeof v.textStyleId==='string')styleIds.add(v.textStyleId);if(v.scope==='global'&&!globalMap.has(v.key))fail('IMPORT_BINDING_COLLISION','globalSchema');if(v.type==='reference'&&v.targetSectionId!==undefined&&!selected.includes(v.targetSectionId))fail('SECTION_DEPENDENCY_OUTSIDE_SELECTION','targetSectionId');});
  const areaMap=new Map([...areas].map(a=>[a,randomUUID()]));Object.assign(areaIdMap,Object.fromEntries(areaMap));const styleMap=new Map([...styleIds].map(a=>[a,randomUUID()]));
  for(const [old,fresh] of styleMap){if(!source.styles[old])fail('INVALID_DATA','textStyleId');definition.styles[fresh]=structuredClone(source.styles[old]);}
  const layout=original.pageLayoutId??source.book.defaultPageLayoutId,newLayout=randomUUID();
  if(!source.pageLayouts[layout])fail('INVALID_DATA','pageLayoutId');definition.pageLayouts[newLayout]=structuredClone(source.pageLayouts[layout]);
  visit([s,...owned.map(f=>f.value)],v=>{
   if(v.scope==='global'&&!preserveGlobals){const key=globalMap.get(v.key);if(!key)fail('IMPORT_BINDING_COLLISION','globalSchema');v.scope='section';v.key=key;}
   for(const key of ['areaId','ownerAreaId'])if(areaMap.has(v[key]))v[key]=areaMap.get(v[key]);
   for(const key of ['textStyleId','baseTextStyleId'])if(styleMap.has(v[key]))v[key]=styleMap.get(v[key]);
   if(v.type==='reference'&&v.targetSectionId!==undefined)v.targetSectionId=sectionIdMap[v.targetSectionId];
  });
  s.id=sectionIdMap[id];s.pageLayoutId=newLayout;s.origin={templateId:source.templateId,revision:sourceRevision,sectionId:id};s.label=nextLabel(s.nameBase,[...definition.sections,...inserted]);
  for(const f of owned)definition.areaFormats[randomUUID()]=f.value;
  inserted.push(s);
 }
 const position=before===null?definition.sections.length:definition.sections.findIndex((s:Json)=>s.id===before);
 definition.sections.splice(position,0,...inserted);
 return {definition,sectionIdMap,areaIdMap,inserted:inserted.map((s,i)=>({sourceSectionId:selected[i],sectionId:s.id,label:s.label}))};
}

export function cloneInstances(source:Json,target:{templateId:string;docKey:string;name:string},revision:number){
 const empty={...structuredClone(source),...target,sections:[],styles:{},pageLayouts:{},areaFormats:{},examples:[]};
 const result=importSections(empty,source,source.sections.map((s:Json)=>s.id),revision,null,{},true);
 result.definition.globalSchema=structuredClone(source.globalSchema);
 visit(result.definition.globalSchema,v=>{if(v.type==='area'&&result.areaIdMap[v.areaId])v.areaId=result.areaIdMap[v.areaId];});
 result.definition.book.defaultPageLayoutId=result.definition.sections[0].pageLayoutId;
 return result;
}
