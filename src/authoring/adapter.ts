import {randomUUID} from 'node:crypto';
import type {TemplateDefinition} from '@flowdoc/core';
import {decompose,checkRecord,schemaScope,type CurrentRecord} from '../templates/assembly.js';
import {OperationError} from '../errors.js';

function identities(record:CurrentRecord){
 const rows=new Map<string,{kind:string;row:any}>();
 for(const [kind,list] of [['section',record.sections??[]],['format',record.formats],['schema',record.schemas],['variable',record.variables]] as const)
  for(const row of list)rows.set(row.id,{kind,row});
 const keys=new Map<string,string>();
 const key=(id:string|null|undefined):string=>{
  if(!id)return '';if(keys.has(id))return keys.get(id)!;
  const found=rows.get(id);if(!found)throw new OperationError('INVALID_DATA','identity','Missing identity');
  const {kind,row:r}=found;
  const value=JSON.stringify(kind==='section'?[kind,r.sourceDefinitionId]:kind==='format'?[kind,key(r.sectionId),key(r.ownerAreaVariableId),r.sourceDefinitionId??r.key]:kind==='schema'?[kind,key(r.sectionId),key(r.formatId),schemaScope(r)]:[kind,key(r.schemaId),key(r.parentId),r.key]);
  keys.set(id,value);return value;
 };
 for(const id of rows.keys())key(id);
 return {rows,keys};
}
/** Full-definition adapter: preserve normalized IDs by logical ownership, never array position. */
export function reconcileDefinition(definition:TemplateDefinition,previous?:CurrentRecord):CurrentRecord{
 const next=decompose(definition,randomUUID);if(!previous)return next;
 if(previous.templateId!==definition.templateId)throw new OperationError('TEMPLATE_IDENTITY_CONFLICT','templateId','Template identity cannot change');
 const old=identities(previous),fresh=identities(next),byKey=new Map([...old.keys].map(([id,key])=>[key,id])),mapping=new Map<string,string>();
 for(const [id,key] of fresh.keys)mapping.set(id,byKey.get(key)??id);
 const nextKeys=new Set(fresh.keys.values());
 const removed=previous.variables.filter(v=>!nextKeys.has(old.keys.get(v.id)!));
 const added=next.variables.filter(v=>!byKey.has(fresh.keys.get(v.id)!));
 for(const a of added)for(const b of removed)if(a.typeId===b.typeId&&(a.key===b.key||fresh.keys.get(a.schemaId)===old.keys.get(b.schemaId)))
  throw new OperationError('OWNERSHIP_CONFLICT','definition','Ambiguous variable rename or move; retained identities require unchanged keys and owners');
 for(const [id,{kind,row}] of fresh.rows){
  const stable=kind==='section'?row.sourceDefinitionId:kind==='format'?row.sourceDefinitionId:kind==='variable'&&row.typeId===110006?row.payload.areaId:undefined;
  if(stable!==undefined)for(const [oldId,prior] of old.rows)if(prior.kind===kind){
   const oldStable=kind==='section'?prior.row.sourceDefinitionId:kind==='format'?prior.row.sourceDefinitionId:prior.row.typeId===110006?prior.row.payload.areaId:undefined;
   if(stable===oldStable&&fresh.keys.get(id)!==old.keys.get(oldId))throw new OperationError('OWNERSHIP_CONFLICT','definition','Existing identity cannot move between owners');
  }
 }
 for(const {row} of fresh.rows.values())for(const field of ['id','sectionId','formatId','schemaId','parentId','ownerAreaVariableId'])if(row[field])row[field]=mapping.get(row[field])??row[field];
 next.revision=previous.revision;checkRecord(next);return next;
}
