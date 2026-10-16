import type {PoolClient} from 'pg';
import {loadBundledResources,loadLibraryFonts} from '@flowdoc/core';
import type {LibraryFontInput} from '@flowdoc/core';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fingerprint,fontError} from './repository.js';
import {SHA} from './files.js';
import type {FontTuple} from './retention.js';
const vendor=JSON.parse(readFileSync(new URL('../../vendor/manifest.json',import.meta.url),'utf8'));
export const rendererIdentity={package:'@flowdoc/core',version:vendor.version,sha256:vendor.sha256};
export interface SnapshotBinding extends FontTuple {styleId:string;faceId:string;assetId:string;sha256:string;storageKey:string;licenses:{id:string;sha256:string;storageKey:string}[]}
export interface FontSnapshot {version:1;definitionFingerprint:string;inputFingerprint:string;rendererIdentity:typeof rendererIdentity;bindings:SnapshotBinding[];legacy:{id:string;sha256:string}[];manifestDigest:string}
export const fontRoot=()=>resolve(process.env.FONT_STORAGE_DIR??'staging/fonts');
export function makeFontSnapshot(definitionFingerprint:string,inputFingerprint:string,bindings:SnapshotBinding[],legacy:FontSnapshot['legacy']=[]):FontSnapshot{
 const body={version:1 as const,definitionFingerprint,inputFingerprint,rendererIdentity,bindings,legacy};return {...body,manifestDigest:fingerprint(body)};
}
export function validateFontSnapshot(raw:FontSnapshot|undefined,definitionFingerprint:string,inputFingerprint:string):FontSnapshot{
 if(!raw||raw.version!==1||raw.definitionFingerprint!==definitionFingerprint||raw.inputFingerprint!==inputFingerprint||fingerprint(raw.rendererIdentity)!==fingerprint(rendererIdentity)||!Array.isArray(raw.bindings)||!Array.isArray(raw.legacy))return fontError('FONT_CHECK_UNAVAILABLE');
 const {manifestDigest,...body}=raw;if(fingerprint(body)!==manifestDigest)return fontError('FONT_CHECK_UNAVAILABLE');return raw;
}
export async function snapshotResources(snapshot:FontSnapshot,tempRoot:string,root=fontRoot()){
 const base=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot});if(!base.ok)return fontError('FONT_CHECK_UNAVAILABLE');
 for(const f of snapshot.legacy)if(!base.value.fonts.some(b=>b.id===f.id&&b.sha256===f.sha256))fontError('FONT_ASSET_HASH_MISMATCH');
 const path=(key:string,hash:string)=>{if(!SHA.test(hash)||key!==hash+'.bin')fontError('FONT_ASSET_UNAVAILABLE');return join(root,'assets',key);};
 const inputs=new Map<string,LibraryFontInput>();
 for(const f of snapshot.bindings)inputs.set(f.releaseId+':'+f.weight+':'+f.style,{releaseId:f.releaseId,faceId:f.faceId,assetId:f.assetId,weight:f.weight,style:f.style,sha256:f.sha256,path:path(f.storageKey,f.sha256),licenses:f.licenses.map(l=>({id:l.id,sha256:l.sha256,path:path(l.storageKey,l.sha256)}))});
 const resources=await loadLibraryFonts(base.value,[...inputs.values()]);if(!resources.ok)return fontError(resources.issues[0]?.code??'FONT_CHECK_UNAVAILABLE');return resources.value;
}
export async function persistJobFonts(c:PoolClient,jobId:string,snapshot:FontSnapshot){
 const inserted=await c.query('INSERT INTO job_font_snapshots(job_id,snapshot) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING job_id',[jobId,JSON.stringify(snapshot)]);
 if(!inserted.rowCount)return; // An upload replay retains its original immutable snapshot.
 const ids=[...new Set(snapshot.bindings.flatMap(f=>[f.assetId,...f.licenses.map(l=>l.id)]))];
 for(const id of ids)await c.query('INSERT INTO job_font_assets(job_id,asset_id) VALUES($1,$2)',[jobId,id]);
}
