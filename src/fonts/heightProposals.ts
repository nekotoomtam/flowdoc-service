import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {calculateFontHeightAdjustment,FONT_HEIGHT_METHOD} from '@flowdoc/core';
import {transaction} from '../db/connection.js';
import {failure,OperationError} from '../errors.js';
import {UUID,createFontFiles} from './files.js';
import {fontRoot} from './snapshot.js';
import {fingerprint} from './repository.js';
import {readReferences,verifyReferences,tupleKey,type ReferenceSet} from './retention.js';
const fail=(code:string):never=>{throw new OperationError(code,'fontHeightAdjustment','Font height adjustment could not be applied');};
const unavailable=(reason:string)=>({status:'unavailable',reason});
function input(raw:unknown,keys:string[]){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))fail('INVALID_FONT_INPUT');const r=raw as any;if(!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||typeof r.idempotencyKey!=='string'||!r.idempotencyKey.length||r.idempotencyKey.length>200)fail('INVALID_FONT_INPUT');return r;}
function selection(f:any){return f&&typeof f==='object'&&!Array.isArray(f)&&Object.keys(f).length===4&&f.kind==='library'&&typeof f.releaseId==='string'&&UUID.test(f.releaseId)&&Number.isInteger(f.weight)&&f.weight>=1&&f.weight<=1000&&['normal','italic'].includes(f.style);}
async function permitted(c:PoolClient,f:any,refs:ReferenceSet|null){
 const r=(await c.query('SELECT * FROM font_releases WHERE id=$1',[f.releaseId])).rows[0];
 if(!r||r.deleted_at||!r.ever_activated_at||!(r.state==='active'||r.state==='retired'&&refs?.bindings.some(t=>tupleKey(t)===tupleKey(f))))return false;
 return !!(await c.query('SELECT 1 FROM font_faces WHERE release_id=$1 AND approved_weight=$2 AND style=$3',[f.releaseId,f.weight,f.style])).rowCount;
}
/** Caller locks all relevant release rows, serializing reviews/assignments/lifecycle. */
export async function resolvedHeightProfile(c:PoolClient,f:any){
 const r=(await c.query('SELECT manifest_digest FROM font_releases WHERE id=$1',[f.releaseId])).rows[0];
 const a=(await c.query('SELECT * FROM font_height_profile_assignments WHERE release_id=$1 AND method_id=$2',[f.releaseId,FONT_HEIGHT_METHOD])).rows[0];
 if(!a){
  // Unassigned measurements may explain why the helper is unavailable, never
  // supply a metric. Only the administrator's reviewed assignment grants that.
  const measured=(await c.query('SELECT * FROM font_height_profiles WHERE release_id=$1 AND release_manifest_digest=$2 AND method_id=$3 ORDER BY measured_at DESC,id DESC LIMIT 1',[f.releaseId,r?.manifest_digest,FONT_HEIGHT_METHOD])).rows[0];
  if(!measured)return {reason:'PROFILE_MISSING'};
  if(measured.outcome==='unavailable')return {reason:measured.reason??'PROFILE_BINDING_INVALID'};
  const review=(await c.query('SELECT decision FROM font_height_profile_reviews WHERE profile_id=$1 ORDER BY sequence DESC LIMIT 1',[measured.id])).rows[0];
  return {reason:review?.decision==='approved'?'PROFILE_MISSING':'PROFILE_UNREVIEWED'};
 }
 const p=(await c.query('SELECT * FROM font_height_profiles WHERE id=$1',[a.profile_id])).rows[0];
 if(!p||p.profile_digest!==a.profile_digest||p.release_id!==f.releaseId||p.release_manifest_digest!==r?.manifest_digest)return {reason:'PROFILE_BINDING_INVALID'};
 if(p.method_id!==FONT_HEIGHT_METHOD)return {reason:'METHOD_UNSUPPORTED'};
 if(p.outcome!=='measured')return {reason:p.reason??'PROFILE_BINDING_INVALID'};
 const review=(await c.query('SELECT decision,sequence FROM font_height_profile_reviews WHERE profile_id=$1 ORDER BY sequence DESC LIMIT 1',[p.id])).rows[0];
 if(review?.decision!=='approved')return {reason:'PROFILE_UNREVIEWED'};
 const faces=(await c.query('SELECT f.id,f.asset_id,f.approved_weight,f.style,a.sha256,a.storage_key,a.byte_length FROM font_faces f JOIN font_assets a ON a.id=f.asset_id WHERE f.release_id=$1 AND (f.id=$2 OR (f.approved_weight=$3 AND f.style=$4))',[f.releaseId,p.regular_face_id,f.weight,f.style])).rows;
 const regular=faces.find(x=>x.id===p.regular_face_id);
 if(!regular||regular.approved_weight!==400||regular.style!=='normal'||regular.asset_id!==p.asset_id||regular.sha256!==p.sha256)return {reason:'PROFILE_BINDING_INVALID'};
 try{const files=await createFontFiles(fontRoot());for(const face of faces)if(!await files.verify(face.storage_key,face.sha256,face.byte_length))return {reason:'RESOURCE_UNAVAILABLE'};}catch{return {reason:'RESOURCE_UNAVAILABLE'};}
 return {metric:{methodId:FONT_HEIGHT_METHOD,unitsPerEm:p.units_per_em as number,topDesign:p.top_design as string},binding:{profileId:p.id,digest:p.profile_digest,assignmentRevision:a.revision,reviewSequence:String(review.sequence)}};
}
interface Hooks {owned:(c:PoolClient,p:string,id:string)=>Promise<any>;view:(c:PoolClient,id:string)=>Promise<any>;receipt:(c:PoolClient,p:string,op:string,id:string,input:any,run:()=>Promise<any>)=>Promise<any>;write:(c:PoolClient,id:string,p:string,definition:any,before:any)=>Promise<any>}
export function createFontHeightAdjustments(pool:Pool,principal:string,h:Hooks){
 const safe=async(run:()=>Promise<any>)=>{try{return {ok:true,value:await run(),warnings:[]};}catch(e){return failure(e instanceof OperationError?e:new OperationError('UNAVAILABLE','fontHeightAdjustment','Font height service unavailable'));}};
 async function owner(c:PoolClient,id:string){if(!UUID.test(id))fail('NOT_FOUND');try{await h.owned(c,principal,id);}catch(e){if(e instanceof OperationError&&e.code==='TEMPLATE_NOT_FOUND')fail('NOT_FOUND');throw e;}}
 const revision=(expected:number,actual:number)=>{if(expected!==actual)fail('STALE_CURRENT');};
 async function state(c:PoolClient,id:string,d:any,target:any){
  const refs=await readReferences(c,id,d.revision);verifyReferences(d.definition,d.fingerprint,refs);
  const ids=[...new Set([...Object.values(d.definition.styles).flatMap((s:any)=>s.font?.kind==='library'?[s.font.releaseId]:[]),target.releaseId])].sort();
  await c.query('SELECT id FROM font_releases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);return refs;
 }
 return {
  proposeFontHeight:(id:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const v=input(raw,['expectedRevision','styleId','targetFont','idempotencyKey']);await owner(c,id);
   if(typeof v.styleId!=='string'||!v.styleId||!selection(v.targetFont))fail('INVALID_FONT_INPUT');
   return h.receipt(c,principal,'font-height-propose',id,v,async()=>{
    const d=await h.view(c,id);revision(v.expectedRevision,d.revision);
    if(!d.definition||!Object.hasOwn(d.definition.styles,v.styleId))fail('INVALID_FONT_INPUT');
    if(d.definition.schemaVersion!==2)return unavailable('LEGACY_STYLE_UNSUPPORTED');
    const s=d.definition.styles[v.styleId];if(s.font.kind==='unselected')return unavailable('FONT_NOT_SELECTED');
    const refs=await state(c,id,d,v.targetFont);
    if(!await permitted(c,v.targetFont,refs))fail('FONT_TARGET_UNAVAILABLE');
    if(!await permitted(c,s.font,refs))return unavailable('RESOURCE_UNAVAILABLE');
    const source=await resolvedHeightProfile(c,s.font),target=await resolvedHeightProfile(c,v.targetFont);
    if(!source.metric)return unavailable(source.reason!);if(!target.metric)return unavailable(target.reason!);
    const result=calculateFontHeightAdjustment({fontSizePt:s.fontSize.value,sourceMetric:source.metric,targetMetric:target.metric});
    if(!result.ok)return unavailable(result.code);
    const proposalId=randomUUID(),payload={status:'proposed',proposalId,expectedRevision:d.revision,definitionFingerprint:d.fingerprint,styleId:v.styleId,sourceFont:s.font,targetFont:v.targetFont,sourceFontSizePt:s.fontSize.value,proposedFontSizePt:result.value.fontSizePt,lineHeightPt:s.lineHeightPt,sourceProfileId:source.binding!.profileId,targetProfileId:target.binding!.profileId,methodId:FONT_HEIGHT_METHOD,precisionDecimals:6,layoutCheck:'not_checked',sourceBinding:source.binding,targetBinding:target.binding};
    const row=(await c.query('INSERT INTO font_height_adjustment_proposals(id,template_id,principal,payload) VALUES($1,$2,$3,$4) RETURNING expires_at',[proposalId,id,principal,JSON.stringify(payload)])).rows[0];
    const {sourceBinding,targetBinding,...publicValue}=payload;return {...publicValue,expiresAt:row.expires_at.toISOString()};
   });
  })),
  confirmFontHeight:(id:string,proposalId:string,raw:unknown)=>safe(()=>transaction(pool,async c=>{
   const v=input(raw,['expectedRevision','idempotencyKey']);await owner(c,id);if(!UUID.test(proposalId))fail('NOT_FOUND');
   const row=(await c.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM font_height_adjustment_proposals WHERE id=$1 AND template_id=$2 AND principal=$3',[proposalId,id,principal])).rows[0];if(!row)fail('NOT_FOUND');
   return h.receipt(c,principal,'font-height-confirm',id,{...v,proposalId},async()=>{
    if(row.expired)fail('FONT_HEIGHT_PROPOSAL_EXPIRED');const p=row.payload,d=await h.view(c,id);revision(v.expectedRevision,d.revision);revision(p.expectedRevision,d.revision);
    if(d.fingerprint!==p.definitionFingerprint)fail('STALE_CURRENT');
    const s=d.definition?.styles[p.styleId];if(!s||fingerprint(s.font)!==fingerprint(p.sourceFont)||s.fontSize.value!==p.sourceFontSizePt||s.lineHeightPt!==p.lineHeightPt)fail('STALE_CURRENT');
    const refs=await state(c,id,d,p.targetFont);if(!await permitted(c,p.targetFont,refs))fail('FONT_TARGET_UNAVAILABLE');
    if(!await permitted(c,p.sourceFont,refs))fail('FONT_HEIGHT_PROFILE_CHANGED');
    const source=await resolvedHeightProfile(c,p.sourceFont),target=await resolvedHeightProfile(c,p.targetFont);
    if(!source.metric||!target.metric||fingerprint(source.binding)!==fingerprint(p.sourceBinding)||fingerprint(target.binding)!==fingerprint(p.targetBinding))fail('FONT_HEIGHT_PROFILE_CHANGED');
    if((await c.query('SELECT expires_at<=clock_timestamp() AS expired FROM font_height_adjustment_proposals WHERE id=$1',[proposalId])).rows[0].expired)fail('FONT_HEIGHT_PROPOSAL_EXPIRED');
    // The proposal owns the calculated pt. Callers cannot override it.
    const definition=structuredClone(d.definition);definition.styles[p.styleId].font=p.targetFont;definition.styles[p.styleId].fontSize.value=p.proposedFontSizePt;
    const result=await h.write(c,id,principal,definition,d);return {...result,proposalId,appliedFontSizePt:p.proposedFontSizePt};
   });
  }))
 };
}
