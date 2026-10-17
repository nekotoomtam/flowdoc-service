import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '../db/connection.js';
import {validateTemplate} from '@flowdoc/core';
import {OperationError,IssueError} from '../errors.js';
import {readReferences,verifyReferences} from '../fonts/retention.js';
import {readRecord,writeCurrent} from '../templates/storage.js';
import {reconcileDefinition} from './adapter.js';
import {importSections,nextLabel} from './sectionInstances.js';
type Hooks={owned:(c:PoolClient,p:string,id:string)=>Promise<any>;view:(c:PoolClient,id:string)=>Promise<any>;receipt:(c:PoolClient,p:string,op:string,id:string,input:any,run:()=>Promise<any>)=>Promise<any>;revision:(e:unknown,a:number)=>void;fields:(v:unknown,keys:string[])=>any;safe:(fn:()=>Promise<any>)=>Promise<any>};
const invalid=(p:string):never=>{throw new OperationError('INVALID_DATA',p,'Invalid Section operation');};
export function createSectionOperations(pool:Pool,principal:string,h:Hooks){return {
 importSections:(targetId:string,raw:unknown)=>h.safe(()=>transaction(pool,async c=>{
  const input=h.fields(raw,['sourceTemplateId','sourceRevision','sourceSectionIds','expectedRevision','beforeSectionId','idempotencyKey','globalFieldRenames']);
  if(typeof input.sourceTemplateId!=='string'||!Array.isArray(input.sourceSectionIds)||!input.sourceSectionIds.length||input.sourceSectionIds.some((v:any)=>typeof v!=='string')||new Set(input.sourceSectionIds).size!==input.sourceSectionIds.length||!(input.beforeSectionId===null||typeof input.beforeSectionId==='string'))invalid('sourceSectionIds');
  // Identical sorted row-lock order for both directions, including same-draft copy.
  for(const id of [...new Set([targetId,input.sourceTemplateId])].sort())await h.owned(c,principal,id);
  return h.receipt(c,principal,'import-sections',targetId,input,async()=>{
   const source=await h.view(c,input.sourceTemplateId),target=await h.view(c,targetId);h.revision(input.sourceRevision,source.revision);h.revision(input.expectedRevision,target.revision);
   if(!source.definition)throw new OperationError('DRAFT_EMPTY','source','Source draft is empty');
   if(source.definition.nodeModelVersion!==19||(target.definition&&target.definition.nodeModelVersion!==19))throw new OperationError('VERSION_MISMATCH','nodeModelVersion','Convert legacy definitions explicitly before import');
   const sourceRefs=await readReferences(c,source.templateId,source.revision);verifyReferences(source.definition,source.fingerprint,sourceRefs);
   const empty={schemaVersion:source.definition.schemaVersion,nodeModelVersion:19,templateId:target.templateId,docKey:target.docKey,name:target.name,version:1,globalSchema:{type:'object',fields:{}},book:{contentSlot:'body',defaultPageLayoutId:''},styles:{},pageLayouts:{},sections:[],areaFormats:{},examples:[]};
   const copied=importSections(target.definition??empty,source.definition,input.sourceSectionIds,input.sourceRevision,input.beforeSectionId,input.globalFieldRenames);
   if(!target.definition)copied.definition.book.defaultPageLayoutId=copied.definition.sections[0].pageLayoutId;
   const valid=validateTemplate(copied.definition);if(!valid.ok)throw new IssueError(valid.issues);
   const record=reconcileDefinition(valid.value.definition,target.definition?await readRecord(c,targetId):undefined);
   await writeCurrent(c,record,sourceRefs,sourceRefs?[sourceRefs]:[]);
   await c.query('INSERT INTO authoring_audit(template_id,principal,revision,operation,summary) VALUES($1,$2,$3,$4,$5)',[targetId,principal,target.revision+1,'import-sections',JSON.stringify({sourceTemplateId:source.templateId,sourceRevision:source.revision,sectionIdMap:copied.sectionIdMap})]);
   return {...await h.view(c,targetId),inserted:copied.inserted,sectionIdMap:copied.sectionIdMap};
  });
 })),
 createSection:(id:string,raw:unknown)=>h.safe(()=>transaction(pool,async c=>{
  const input=h.fields(raw,['expectedRevision','pageLayoutId','idempotencyKey']);await h.owned(c,principal,id);
  return h.receipt(c,principal,'create-section',id,input,async()=>{
   const before=await h.view(c,id);h.revision(input.expectedRevision,before.revision);if(!before.definition)throw new OperationError('DRAFT_EMPTY','draft','Save a definition before creating a Section');
   if(before.definition.nodeModelVersion!==19)throw new OperationError('VERSION_MISMATCH','nodeModelVersion','Section authoring requires model19');
   const d=structuredClone(before.definition);if(typeof input.pageLayoutId!=='string'||!Object.hasOwn(d.pageLayouts,input.pageLayoutId))invalid('pageLayoutId');
   const layout=randomUUID(),section={id:randomUUID(),label:nextLabel(d.name,d.sections),nameBase:d.name,pageLayoutId:layout,inputSchema:{type:'object',fields:{}},source:{kind:'authored',fragment:{rootIds:[],nodes:{}},repeats:[]}};
   d.pageLayouts[layout]=structuredClone(d.pageLayouts[input.pageLayoutId]);d.sections.push(section);
   const valid=validateTemplate(d);if(!valid.ok)throw new IssueError(valid.issues);
   await writeCurrent(c,reconcileDefinition(valid.value.definition,await readRecord(c,id)));
   await c.query('INSERT INTO authoring_audit(template_id,principal,revision,operation,summary) VALUES($1,$2,$3,$4,$5)',[id,principal,before.revision+1,'create-section',JSON.stringify({sectionId:section.id})]);
   return {...await h.view(c,id),section};
  });
 })),
};}
