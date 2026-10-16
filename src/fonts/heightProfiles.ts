import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '../db/connection.js';
import {createFontFiles,UUID,SHA} from './files.js';
import {inspectFont} from './inspection.js';
import {audit,receipt,fingerprint,fontError} from './repository.js';
import type {FontHeightMetric,Mutation} from './types.js';
export const HEIGHT_METHOD='thai-bo-baseline-top-v1' as const;
export const HEIGHT_REFERENCE=Object.freeze({id:'th-sarabun-new-1.35-regular',methodId:HEIGHT_METHOD,
 sha256:'b248f824f3d7a8576bc396826a4d898070c1420564f6ce6aa716aa8ad24f824a'});
function validate(id:string,input:Mutation,extra:string[]){
 if(!UUID.test(id)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['requestId','reason','expectedRevision',...extra].includes(k))||typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>200||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fontError('INVALID_FONT_INPUT');
}
const revision=(wanted:number,actual:number)=>{if(wanted!==actual)fontError('STALE_CURRENT','expectedRevision');};
async function release(c:PoolClient,id:string){
 const r=(await c.query('SELECT * FROM font_releases WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!r||r.deleted_at)fontError('FONT_RELEASE_NOT_FOUND');return r;
}
function value(r:any,reviewStatus='unreviewed'){
 return {schemaVersion:r.schema_version,id:r.id,referenceId:r.reference_id,releaseId:r.release_id,releaseManifestDigest:r.release_manifest_digest,
 regularFaceId:r.regular_face_id,assetId:r.asset_id,sha256:r.sha256,methodId:r.method_id,toolVersion:r.tool_version,
 referenceCodePoint:r.reference_code_point,unitsPerEm:r.units_per_em,baselineDesign:r.baseline_design,topDesign:r.top_design,
 outcome:r.outcome,reason:r.reason,profileDigest:r.profile_digest,measuredAt:r.measured_at.toISOString(),reviewStatus};
}
async function profile(c:PoolClient,id:string){
 const row=(await c.query('SELECT * FROM font_height_profiles WHERE id=$1',[id])).rows[0];
 if(!row)fontError('FONT_HEIGHT_PROFILE_NOT_FOUND');return row;
}
async function status(c:PoolClient,id:string){return (await c.query('SELECT decision FROM font_height_profile_reviews WHERE profile_id=$1 ORDER BY sequence DESC LIMIT 1',[id])).rows[0]?.decision??'unreviewed';}
export function createFontHeightProfiles(options:{pool:Pool;root:string;principal:string;pythonExecutable?:string}){
 const {pool,root,principal}=options;
 async function verify(c:PoolClient,p:any,r:any){
  if(p.release_id!==r.id)fontError('FONT_BINDING_CONFLICT');
  if(p.release_manifest_digest!==r.manifest_digest)fontError('FONT_HEIGHT_PROFILE_STALE');
  if(p.outcome!=='measured')fontError('FONT_HEIGHT_PROFILE_UNAVAILABLE');
  const face=(await c.query('SELECT f.asset_id,a.sha256,a.storage_key,a.byte_length FROM font_faces f JOIN font_assets a ON a.id=f.asset_id WHERE f.id=$1 AND f.release_id=$2 AND f.approved_weight=400 AND f.style=\'normal\'',[p.regular_face_id,r.id])).rows[0];
  if(!face||face.asset_id!==p.asset_id||face.sha256!==p.sha256)fontError('FONT_HEIGHT_PROFILE_STALE');
  const files=await createFontFiles(root);if(!await files.verify(face.storage_key,face.sha256,face.byte_length))fontError('FONT_ASSET_UNAVAILABLE');
 }
 async function review(id:string,input:Mutation&{profileDigest:string},decision:'approved'|'revoked'){
  validate(id,input,['profileDigest']);if(!SHA.test(input.profileDigest))fontError('INVALID_FONT_INPUT');
  return transaction(pool,c=>receipt(c,principal,'height-'+decision,id,input,async()=>{
   const p=await profile(c,id),r=await release(c,p.release_id);revision(input.expectedRevision,r.revision);
   if(p.profile_digest!==input.profileDigest)fontError('FONT_HEIGHT_PROFILE_STALE');
   // Revocation remains possible even if a preparing manifest or its bytes changed.
   if(decision==='approved')await verify(c,p,r);
   await c.query('INSERT INTO font_height_profile_reviews(id,profile_id,profile_digest,decision,reviewer,reason) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,p.profile_digest,decision,principal,input.reason]);
   await audit(c,principal,'height-'+decision,input,{profileId:id,profileDigest:p.profile_digest},r.id);
   return value(p,decision);
  }));
 }
 return {
  async get(id:string){if(!UUID.test(id))fontError('INVALID_FONT_INPUT');return transaction(pool,async c=>{const p=await profile(c,id);return value(p,await status(c,id));});},
  async measure(id:string,input:Mutation&{manifestDigest:string}){
   validate(id,input,['manifestDigest']);if(!SHA.test(input.manifestDigest))fontError('INVALID_FONT_INPUT');
   return transaction(pool,c=>receipt(c,principal,'height-measure',id,input,async()=>{
    const r=await release(c,id);revision(input.expectedRevision,r.revision);
    if(input.manifestDigest!==r.manifest_digest)fontError('FONT_HEIGHT_PROFILE_STALE');
    const face=(await c.query("SELECT f.id,f.asset_id,a.sha256,a.storage_key,a.byte_length FROM font_faces f JOIN font_assets a ON a.id=f.asset_id WHERE f.release_id=$1 AND f.approved_weight=400 AND f.style='normal'",[id])).rows[0];
    let metric:FontHeightMetric|undefined;
    if(face){const files=await createFontFiles(root);if(!await files.verify(face.storage_key,face.sha256,face.byte_length))fontError('FONT_ASSET_UNAVAILABLE');
     const inspected=await inspectFont(files.assetPath(face.storage_key),{includeHeightMetric:true,...(options.pythonExecutable?{pythonExecutable:options.pythonExecutable}:{})});
     if(inspected.sha256!==face.sha256)fontError('FONT_HASH_MISMATCH');metric=inspected.heightMetric;
     if(!metric)fontError('FONT_HEIGHT_PROFILE_UNAVAILABLE');
    }
    const data={schemaVersion:1,referenceId:face?.sha256===HEIGHT_REFERENCE.sha256?HEIGHT_REFERENCE.id:null,releaseId:id,releaseManifestDigest:r.manifest_digest,regularFaceId:face?.id??null,assetId:face?.asset_id??null,sha256:face?.sha256??null,
     methodId:HEIGHT_METHOD,toolVersion:metric?.toolVersion??'not-run',referenceCodePoint:3610,unitsPerEm:metric?.unitsPerEm??null,baselineDesign:'0',topDesign:metric?.topDesign??null,
     outcome:metric?.outcome??'unavailable',reason:metric?.reason??(face?null:'REGULAR_MISSING')};
    const digest=fingerprint(data),p=(await c.query(`INSERT INTO font_height_profiles(id,schema_version,release_id,release_manifest_digest,regular_face_id,asset_id,sha256,method_id,tool_version,reference_code_point,units_per_em,baseline_design,top_design,outcome,reason,profile_digest,reference_id)
     VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,3610,$9,'0',$10,$11,$12,$13,$14) ON CONFLICT(profile_digest) DO NOTHING RETURNING *`,[randomUUID(),id,r.manifest_digest,data.regularFaceId,data.assetId,data.sha256,HEIGHT_METHOD,data.toolVersion,data.unitsPerEm,data.topDesign,data.outcome,data.reason,digest,data.referenceId])).rows[0]
     ??(await c.query('SELECT * FROM font_height_profiles WHERE profile_digest=$1',[digest])).rows[0];
    await audit(c,principal,'height-measure',input,{profileId:p.id,profileDigest:digest},id);return value(p,await status(c,p.id));
   }));
  },
  approve:(id:string,input:Mutation&{profileDigest:string})=>review(id,input,'approved'),
  revoke:(id:string,input:Mutation&{profileDigest:string})=>review(id,input,'revoked'),
  async assign(id:string,input:Mutation&{profileId:string;profileDigest:string}){
   validate(id,input,['profileId','profileDigest']);if(!UUID.test(input.profileId)||!SHA.test(input.profileDigest))fontError('INVALID_FONT_INPUT');
   return transaction(pool,c=>receipt(c,principal,'height-assign',id,input,async()=>{
    const r=await release(c,id),p=await profile(c,input.profileId);await verify(c,p,r);
    if(p.profile_digest!==input.profileDigest)fontError('FONT_HEIGHT_PROFILE_STALE');
    if(await status(c,p.id)!=='approved')fontError('FONT_HEIGHT_PROFILE_UNREVIEWED');
    const old=(await c.query('SELECT revision FROM font_height_profile_assignments WHERE release_id=$1 AND method_id=$2',[id,HEIGHT_METHOD])).rows[0];revision(input.expectedRevision,old?.revision??0);
    const next=(old?.revision??0)+1;
    await c.query(`INSERT INTO font_height_profile_assignments(release_id,method_id,profile_id,profile_digest,revision) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(release_id,method_id) DO UPDATE SET profile_id=EXCLUDED.profile_id,profile_digest=EXCLUDED.profile_digest,revision=EXCLUDED.revision,updated_at=now()`,[id,HEIGHT_METHOD,p.id,p.profile_digest,next]);
    await audit(c,principal,'height-assign',input,{profileId:p.id,profileDigest:p.profile_digest,revision:next},id);
    return {releaseId:id,profileId:p.id,profileDigest:p.profile_digest,methodId:HEIGHT_METHOD,revision:next};
   }));
  }
 };
}
