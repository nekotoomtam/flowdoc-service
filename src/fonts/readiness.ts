import {LEGACY_SARABUN} from './legacy.js';
import {fontProbeDocument} from './probe.js';
import type {PoolClient} from 'pg';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tupleKey,type ReferenceSet} from './retention.js';
import {fingerprint} from './repository.js';
import {makeFontSnapshot,snapshotResources,fontRoot,type SnapshotBinding,type FontSnapshot} from './snapshot.js';
import {renderDocumentJob} from '../jobs/render.js';
export interface FontIssue {code:string;path:string;message:string;remedy:string;styleIds:string[];occurrences:{nodeId:string;sectionId?:string;inlineId?:string;codePointIndex?:number}[];samples:string[];total:number;truncated:boolean}
export interface FontReadiness {status:'ready'|'blocked'|'incomplete';checkedScope:'styles'|'actual_input';definitionFingerprint:string;inputFingerprint?:string;issues:FontIssue[];total:number;truncated:boolean}
const incomplete=(code:string)=>/ASSET_|LICENSE_|CHECK_UNAVAILABLE|RESOURCE_UNAVAILABLE/.test(code);
export function fontIssue(code:string,styleId?:string):FontIssue{return {code,path:styleId?'/styles/'+styleId.replaceAll('~','~0').replaceAll('/','~1')+'/font':'/font',message:'Font selection or verified resource is not ready',remedy:incomplete(code)?'Restore the exact font/license files or retry the check':'Select an available released face supporting the required text',styleIds:styleId?[styleId]:[],occurrences:[],samples:[],total:1,truncated:false};}
/** Diagnostic locator only; Core shaping remains authoritative for readiness. */
export function locateMissingGlyphs(document:any,coverage:Map<string,Set<number>>):FontIssue[]{
 const issues=new Map<string,FontIssue>(),seen=new Set<string>();
 const visit=(v:any)=>{
  if(!v||typeof v!=='object')return;
  if(v.type==='text-block'&&!seen.has(v.id)){
   seen.add(v.id);const style=v.props?.textStyleId,cmap=coverage.get(style);
   if(cmap)for(const inline of v.children??[]){
    const text=inline.type==='text'?inline.text:inline.type==='link'?inline.label??'':'';let index=0;
    for(const ch of text){const cp=ch.codePointAt(0)!;
     if(!/[\r\n\t]/.test(ch)&&!cmap.has(cp)){
      let issue=issues.get(style);if(!issue){issue=fontIssue('FONT_GLYPH_MISSING',style);issue.total=0;issues.set(style,issue);}
      issue.total++;if(issue.occurrences.length<16)issue.occurrences.push({nodeId:v.id,inlineId:inline.id,codePointIndex:index,...(document.sourceMap?.[v.id]?.sectionId?{sectionId:document.sourceMap[v.id].sectionId}:{})});
      const sample='U+'+cp.toString(16).toUpperCase().padStart(4,'0');if(issue.samples.length<8&&!issue.samples.includes(sample))issue.samples.push(sample);issue.truncated=issue.total>16;
     }index++;
    }
   }
  }
  for(const x of Object.values(v))if(x&&typeof x==='object')Array.isArray(x)?x.forEach(visit):visit(x);
 };visit(document);return [...issues.values()];
}
export async function resolveFontReadiness(c:Pick<PoolClient,'query'>,definition:any,definitionFingerprint:string,refs:ReferenceSet|null=null,actual?:{document:any;input:unknown},root?:string):Promise<{readiness:FontReadiness;snapshot?:FontSnapshot}>{
 const issues:FontIssue[]=[],bindings:SnapshotBinding[]=[],legacy:FontSnapshot['legacy']=[],coverage=new Map<string,Set<number>>();
 const inputFingerprint=fingerprint(actual?.input??null);
 if(refs&&refs.definitionFingerprint!==definitionFingerprint)issues.push(fontIssue('FONT_CHECK_UNAVAILABLE'));
 for(const [styleId,s] of Object.entries(definition.styles) as [string,any][]){
  if(definition.schemaVersion!==2)continue;
  try{
   const f=s.font;
   if(f.kind==='unselected'){issues.push(fontIssue('FONT_NOT_SELECTED',styleId));continue;}
   const release=(await c.query('SELECT id,state,ever_activated_at FROM font_releases WHERE id=$1',[f.releaseId])).rows[0];
   let code=!release?'FONT_RELEASE_NOT_FOUND':release.state==='retired'?!refs?.bindings.some(t=>tupleKey(t)===tupleKey(f))?'FONT_REFERENCE_NOT_RETAINED':null:release.state!=='active'?'FONT_RELEASE_NOT_ACTIVE':null;
   if(!code&&release&&!release.ever_activated_at)code='FONT_RELEASE_NOT_ACTIVE';
   if(code){issues.push(fontIssue(code,styleId));continue;}
   const face=(await c.query('SELECT f.id,f.asset_id,a.sha256,a.storage_key,a.parsed_metadata,e.metadata FROM font_faces f JOIN font_assets a ON a.id=f.asset_id JOIN font_source_evidence e ON e.id=f.source_evidence_id WHERE f.release_id=$1 AND f.approved_weight=$2 AND f.style=$3',[f.releaseId,f.weight,f.style])).rows[0];
   if(!face){issues.push(fontIssue('FONT_FACE_UNAVAILABLE',styleId));continue;}
   coverage.set(styleId,new Set(face.parsed_metadata.coverage));
   const licenseIds=face.metadata.licenseAssetIds;
   if(!Array.isArray(licenseIds)||!licenseIds.length){issues.push(fontIssue('FONT_CHECK_UNAVAILABLE',styleId));continue;}
   const licenses=(await c.query("SELECT id,sha256,storage_key AS \"storageKey\" FROM font_assets WHERE id=ANY($1::uuid[]) AND format='license-text' ORDER BY id",[licenseIds])).rows;
   if(licenses.length!==licenseIds.length){issues.push(fontIssue('FONT_CHECK_UNAVAILABLE',styleId));continue;}
   bindings.push({styleId,releaseId:f.releaseId,weight:f.weight,style:f.style,faceId:face.id,assetId:face.asset_id,sha256:face.sha256,storageKey:face.storage_key,licenses});
  }catch{issues.push(fontIssue('FONT_CHECK_UNAVAILABLE',styleId));}
 }
 let snapshot:FontSnapshot|undefined;
 if(!issues.length){
  let temp:string|undefined;
  try{
   temp=await mkdtemp(join(tmpdir(),'flowdoc-font-check-'));
   if(definition.schemaVersion===1){const expected=refs?.legacyBindings?.length?refs.legacyBindings:LEGACY_SARABUN;
    if(expected.length!==4||expected.some(f=>!LEGACY_SARABUN.some(b=>b.id===f.id&&b.sha256===f.sha256)))throw Object.assign(Error(),{code:'FONT_CHECK_UNAVAILABLE'});
    legacy.push(...expected.map(f=>({id:f.id,sha256:f.sha256})));}
   snapshot=makeFontSnapshot(definitionFingerprint,inputFingerprint,bindings,legacy);
   if(!actual)await snapshotResources(snapshot,temp,root);
   if(actual){const result=await renderDocumentJob({document:fontProbeDocument(actual.document),images:{}},undefined,snapshot,root??fontRoot());
    if(!result.ok)for(const i of result.issues){
     const located=i.code==='FONT_GLYPH_MISSING'?locateMissingGlyphs(actual.document,coverage):[];
     issues.push(...(located.length?located:[fontIssue(i.code.startsWith('FONT_')?i.code:'FONT_CHECK_UNAVAILABLE')]));
    }
   }
  }catch(e){issues.push(fontIssue(typeof (e as any)?.code==='string'&&(e as any).code.startsWith('FONT_')?(e as any).code:'FONT_CHECK_UNAVAILABLE'));}
  finally{if(temp)await rm(temp,{recursive:true,force:true});}
 }
 if(actual)for(const issue of issues){
  if(issue.occurrences.length)continue;
  const found=new Map<string,{nodeId:string;sectionId?:string}>();
  const visit=(v:any)=>{if(!v||typeof v!=='object')return;if(v.type==='text-block'&&(!issue.styleIds.length||issue.styleIds.includes(v.props?.textStyleId))){const source=actual.document.sourceMap?.[v.id];found.set(v.id,{nodeId:v.id,...(source?.sectionId?{sectionId:source.sectionId}:{})});}for(const x of Object.values(v))if(x&&typeof x==='object')Array.isArray(x)?x.forEach(visit):visit(x);};visit(actual.document);
  issue.occurrences=[...found.values()].slice(0,16);issue.total=Math.max(1,found.size);issue.truncated=found.size>16;
 }
 const total=issues.length,status=issues.some(i=>!incomplete(i.code))?'blocked':total?'incomplete':'ready';
 return {readiness:{status,checkedScope:actual?'actual_input':'styles',definitionFingerprint,...(actual?{inputFingerprint}:{}),issues:issues.slice(0,16),total,truncated:total>16},...(!total&&snapshot?{snapshot}: {})};
}
export async function checkFontReadiness(...args:Parameters<typeof resolveFontReadiness>){return (await resolveFontReadiness(...args)).readiness;}
