import {OperationError} from '../errors.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ResolvedDocument} from '@flowdoc/core';
import {renderDocumentJob} from '../jobs/render.js';
import {fontProbeDocument} from './probe.js';
import {makeFontSnapshot,rendererIdentity,type SnapshotBinding} from './snapshot.js';
import {createFontFiles,SHA} from './files.js';
import {inspectFont} from './inspection.js';
import {fontError,fingerprint} from './repository.js';
export const specimen={version:1,en:'Font review ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 () [] + - / . , : ; ! ?',th:'ทดสอบภาษาไทย กุ้ง น้ำ ปี่ ผู้ใหญ่ ญ ฐ ฎ ฏ ฤ ฦ ำ เก้า ปู่ ป้า ๐๑๒๓๔๕๖๗๘๙'};
export const suiteDigest=fingerprint(specimen);
export const bytesHash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export async function reviewSnapshot(c:PoolClient,r:any){
 const rows=(await c.query('SELECT f.id,f.asset_id,f.source_evidence_id,f.raw_weight,f.source_weight,f.approved_weight,f.style,f.conflict_resolution,a.sha256,a.storage_key,a.byte_length,a.parsed_metadata,e.metadata AS source FROM font_faces f JOIN font_assets a ON a.id=f.asset_id JOIN font_source_evidence e ON e.id=f.source_evidence_id WHERE f.release_id=$1 ORDER BY f.id',[r.id])).rows;
 const faces=[];
 for(const f of rows){const licenses=[];for(const id of f.source.licenseAssetIds??[]){const a=(await c.query("SELECT id,sha256,storage_key,byte_length FROM font_assets WHERE id=$1 AND format='license-text'",[id])).rows[0];if(!a)fontError('FONT_LICENSE_UNAVAILABLE');licenses.push(a);}faces.push({...f,licenses});}
 return {releaseId:r.id,manifestDigest:r.manifest_digest,languageScope:r.language_scope,issues:r.issues,faces};
}
export async function verifySnapshot(root:string,snapshot:any){
 const files=await createFontFiles(root);
 for(const f of snapshot.faces){if(!await files.verify(f.storage_key,f.sha256,f.byte_length))fontError('FONT_ASSET_UNAVAILABLE');for(const l of f.licenses)if(!await files.verify(l.storage_key,l.sha256,l.byte_length))fontError('FONT_LICENSE_UNAVAILABLE');}
}
export async function runReview(root:string,snapshot:any){
 const results:{faceId:string;ok:boolean;code?:string;artifactHash?:string}[]=[];
 const structural=[...snapshot.issues];
 if(!snapshot.faces.some((f:any)=>f.approved_weight===400&&f.style==='normal'))structural.push({code:'FONT_REGULAR_400_REQUIRED'});
 const deadline=AbortSignal.timeout(600000);
 for(const f of snapshot.faces){try{
  await verifySnapshot(root,{faces:[f]});
  const m=await inspectFont(join(root,'assets',f.storage_key));
  if(m.sha256!==f.sha256||m.rawWeight!==f.raw_weight||m.style!==f.style||fingerprint(m)!==fingerprint(f.parsed_metadata))fontError('FONT_ASSET_HASH_MISMATCH');
  if(f.approved_weight===null||!f.licenses.length)fontError('FONT_WEIGHT_REVIEW_REQUIRED');
  const binding:SnapshotBinding={styleId:'body',releaseId:snapshot.releaseId,weight:f.approved_weight,style:f.style,faceId:f.id,assetId:f.asset_id,sha256:f.sha256,storageKey:f.storage_key,licenses:f.licenses.map((l:any)=>({id:l.id,sha256:l.sha256,storageKey:l.storage_key}))};
  const text=snapshot.languageScope.map((lang:'th'|'en')=>specimen[lang]).join('\n');
  const base={schemaVersion:2,nodeModelVersion:18,template:{templateId:'font-review',docKey:'font-review',version:1},styles:{body:{font:{kind:'library',releaseId:snapshot.releaseId,weight:f.approved_weight,style:f.style},fontSize:{value:12,unit:'pt'},lineHeightPt:20}},nodes:{p:{id:'p',type:'text-block',props:{textStyleId:'body'},children:[{id:'t',type:'text',text}]}}} as unknown as ResolvedDocument;
  const document=fontProbeDocument(base),fonts=makeFontSnapshot(fingerprint(document),suiteDigest,[binding]);
  const rendered=await renderDocumentJob({document,images:{}},deadline,fonts,root);if(!rendered.ok)throw new OperationError(rendered.issues[0]?.code??'FONT_CHECK_UNAVAILABLE','font','Font specimen did not render');
  const hash=bytesHash(rendered.value.bytes);await mkdir(join(root,'reviews'),{recursive:true});await writeFile(join(root,'reviews',hash+'.pdf'),rendered.value.bytes,{flag:'w',mode:0o600});results.push({faceId:f.id,ok:true,artifactHash:hash});
 }catch(error){const code=(error as any)?.code;results.push({faceId:f.id,ok:false,code:typeof code==='string'&&/^FONT_|^INVALID_FONT_FILE$/.test(code)?code:'FONT_CHECK_UNAVAILABLE'});}}
 return {purpose:'font-review',renderer:rendererIdentity,suiteDigest,manifestDigest:snapshot.manifestDigest,ok:structural.length===0&&results.length>0&&results.every(f=>f.ok),issues:structural,faces:results};
}
export async function readReviewArtifact(root:string,hash:string){if(!SHA.test(hash))fontError('FONT_REVIEW_STALE');let bytes:Buffer;try{bytes=await readFile(join(root,'reviews',hash+'.pdf'));}catch{return fontError('FONT_REVIEW_STALE');}if(bytesHash(bytes)!==hash)fontError('FONT_REVIEW_STALE');return bytes;}
