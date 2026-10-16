import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '../db/connection.js';
import {OperationError} from '../errors.js';
import {FONT_LIMITS,type ImportInput,type FamilyInput,type Mutation,type ReleaseInput,type FontMetadata,type SourceEvidence} from './types.js';
import {createFontFiles,UUID,SHA} from './files.js';
import {inspectFont} from './inspection.js';
import {audit,receipt,fingerprint,fontError,lockHash,canonical} from './repository.js';
function object(v:unknown,allowed:string[]):asserts v is Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fontError('INVALID_FONT_INPUT');
 if(Object.entries(Object.getOwnPropertyDescriptors(v)).some(([k,d])=>!allowed.includes(k)||!Object.hasOwn(d,'value')))fontError('INVALID_FONT_INPUT');
}
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const weight=(v:unknown)=>v===null||Number.isInteger(v)&&Number(v)>=1&&Number(v)<=1000;
function mutation(v:{requestId:string;reason:string}){if(!text(v.requestId)||!text(v.reason,500))fontError('INVALID_FONT_INPUT');}
function revision(input:number,current:number){if(!Number.isSafeInteger(input)||input<0)fontError('INVALID_FONT_INPUT');if(input!==current)fontError('STALE_CURRENT','expectedRevision');}
function importInput(input:ImportInput){
 object(input,['requestId','reason','files','licenseFiles','sourceEvidence']);mutation(input);
 if(!Array.isArray(input.files)||!input.files.length||!Array.isArray(input.licenseFiles)||!Array.isArray(input.sourceEvidence))fontError('INVALID_FONT_INPUT');
 if(input.files.length>FONT_LIMITS.files||input.licenseFiles.length>FONT_LIMITS.licenses||Buffer.byteLength(JSON.stringify(input))>FONT_LIMITS.metadataBytes)fontError('FONT_LIMIT_EXCEEDED');
 const keys=new Set<string>();let total=0;
 for(const [entries,max] of [[input.files,FONT_LIMITS.fileBytes],[input.licenseFiles,FONT_LIMITS.licenseBytes]] as const)for(const e of entries){
  object(e,['clientKey','byteLength','sha256']);
  if(typeof e.clientKey!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(e.clientKey)||keys.has(e.clientKey)||!Number.isSafeInteger(e.byteLength)||e.byteLength<1||!SHA.test(e.sha256))fontError('INVALID_FONT_INPUT');
  if(e.byteLength>max)fontError('FONT_LIMIT_EXCEEDED');total+=e.byteLength;keys.add(e.clientKey);
 }
 if(total>FONT_LIMITS.setBytes)fontError('FONT_LIMIT_EXCEEDED');
 const sources=new Set<string>();
 for(const s of input.sourceEvidence){
  object(s,['clientKey','provider','locator','retrievedAt','metadataHash','fileHashBinding','sourceWeight','licenseClientKeys']);
  if(sources.has(s.clientKey)||s.provider!=='google-fonts'||!text(s.locator,2048)||!s.locator.startsWith('https://')||!text(s.retrievedAt)||!/^\d{4}-\d\d-\d\dT.*Z$/.test(s.retrievedAt)||!Number.isFinite(Date.parse(s.retrievedAt))||!SHA.test(s.metadataHash)||!SHA.test(s.fileHashBinding)||!weight(s.sourceWeight)||!Array.isArray(s.licenseClientKeys)||!s.licenseClientKeys.length)fontError('INVALID_FONT_INPUT');
  const file=input.files.find(f=>f.clientKey===s.clientKey);if(!file||file.sha256!==s.fileHashBinding||new Set(s.licenseClientKeys).size!==s.licenseClientKeys.length||s.licenseClientKeys.some(k=>!input.licenseFiles.some(l=>l.clientKey===k)))fontError('FONT_PROVENANCE_REQUIRED');
  sources.add(s.clientKey);
 }
}
interface InspectedFile {clientKey:string;assetId:string;sourceEvidenceId:string;sha256:string;metadata:FontMetadata}
interface Inspection {id:string;revision:number;state:'inspected';files:InspectedFile[]}
export async function createFontLibrary(options:{pool:Pool;root:string;principal:string;pythonExecutable?:string}){
 const {pool,principal}=options;if(!text(principal))fontError('INVALID_FONT_INPUT');
 const files=await createFontFiles(options.root);
 async function owned(c:PoolClient,id:string,lock=false){
  if(!UUID.test(id))fontError('FONT_IMPORT_NOT_FOUND');
  const r=(await c.query('SELECT * FROM font_imports WHERE id=$1 AND principal=$2'+(lock?' FOR UPDATE':''),[id,principal])).rows[0];
  if(!r)fontError('FONT_IMPORT_NOT_FOUND');return r;
 }
 const live=(r:any)=>{if(new Date(r.expires_at).getTime()<=Date.now())fontError('FONT_IMPORT_EXPIRED');};
 async function getReleaseIn(c:PoolClient,id:string){
  if(!UUID.test(id))fontError('FONT_RELEASE_NOT_FOUND');
  const r=(await c.query('SELECT * FROM font_releases WHERE id=$1',[id])).rows[0];if(!r)fontError('FONT_RELEASE_NOT_FOUND');
  const faces=(await c.query('SELECT id,asset_id AS "assetId",source_evidence_id AS "sourceEvidenceId",raw_weight AS "rawWeight",source_weight AS "sourceWeight",approved_weight AS "approvedWeight",style FROM font_faces WHERE release_id=$1 ORDER BY approved_weight NULLS FIRST,style,asset_id',[id])).rows;
  return {id:r.id,familyId:r.family_id,version:r.version,state:r.state,revision:r.revision,manifestDigest:r.manifest_digest,languageScope:r.language_scope,issues:r.issues,faces,createdAt:r.created_at.toISOString()};
 }
 return {
  files,
  async createFamily(input:FamilyInput){
   object(input,['requestId','reason','displayName','internalNames','sourceIdentity']);mutation(input);object(input.sourceIdentity,['provider','providerFamilyKey']);
   if(!text(input.displayName)||!Array.isArray(input.internalNames)||!input.internalNames.length||input.internalNames.some(n=>!text(n))||input.sourceIdentity.provider!=='google-fonts'||!text(input.sourceIdentity.providerFamilyKey))fontError('INVALID_FONT_INPUT');
   return transaction(pool,c=>receipt(c,principal,'family','',input,async()=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['font-family:'+canonical(input.sourceIdentity)]);
    const previous=(await c.query("SELECT * FROM font_families WHERE source_identity->>'provider'=$1 AND source_identity->>'providerFamilyKey'=$2",[input.sourceIdentity.provider,input.sourceIdentity.providerFamilyKey])).rows[0];
    if(previous){if(previous.display_name!==input.displayName||canonical(previous.internal_names)!==canonical(input.internalNames))fontError('FONT_FAMILY_CONFLICT');return {id:previous.id,revision:previous.revision,existing:true};}
    const id=randomUUID();await c.query('INSERT INTO font_families(id,display_name,internal_names,source_identity) VALUES($1,$2,$3,$4)',[id,input.displayName,JSON.stringify(input.internalNames),JSON.stringify(input.sourceIdentity)]);
    await audit(c,principal,'family-create',input,{familyId:id});return {id,revision:0,existing:false};
   }));
  },
  async createImport(input:ImportInput){
   importInput(input);
   return transaction(pool,c=>receipt(c,principal,'import','',input,async()=>{
    const id=randomUUID();await c.query("INSERT INTO font_imports(id,principal,manifest,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",[id,principal,JSON.stringify(input)]);
    for(const [entries,kind] of [[input.files,'ttf-static'],[input.licenseFiles,'license-text']] as const)for(const f of entries)await c.query('INSERT INTO font_import_files(import_id,client_key,kind,byte_length,sha256) VALUES($1,$2,$3,$4,$5)',[id,f.clientKey,kind,f.byteLength,f.sha256]);
    await audit(c,principal,'import-create',input,{importId:id,count:input.files.length});return {id,revision:0,state:'receiving'};
   }));
  },
  async getImport(id:string){return transaction(pool,async c=>{const r=await owned(c,id);return {id:r.id,revision:r.revision,state:r.state,expiresAt:r.expires_at.toISOString(),inspection:r.inspection};});},
  async receive(id:string,key:string,input:AsyncIterable<Uint8Array>,signal?:AbortSignal){
   return transaction(pool,async c=>{
    const r=await owned(c,id,true);live(r);if(r.state!=='receiving')fontError('FONT_STATE_CONFLICT');
    const e=(await c.query('SELECT * FROM font_import_files WHERE import_id=$1 AND client_key=$2',[id,key])).rows[0];if(!e)fontError('INVALID_FONT_INPUT');
    try{const value=await files.receive(id,key,input,{byteLength:e.byte_length,sha256:e.sha256},signal);await c.query('UPDATE font_import_files SET received=true WHERE import_id=$1 AND client_key=$2',[id,key]);return {sha256:value.sha256,byteLength:value.byteLength};}
    catch(error){if(error instanceof OperationError)throw error;throw new OperationError('FONT_STORAGE_FAILED','font','Font upload did not succeed');}
   });
  },
  async inspectImport(id:string,input:Mutation):Promise<Inspection>{
   object(input,['requestId','reason','expectedRevision']);mutation(input);
   return transaction(pool,async c=>{
    const r=await owned(c,id,true),created:string[]=[];
    try{return await receipt(c,principal,'inspect',id,input,async()=>{
     revision(input.expectedRevision,r.revision);live(r);if(r.state==='inspected')return r.inspection as Inspection;
     const entries=(await c.query('SELECT * FROM font_import_files WHERE import_id=$1 ORDER BY client_key',[id])).rows;
     if(entries.some(e=>!e.received))fontError('FONT_UPLOAD_INCOMPLETE');
     await c.query('SELECT pg_advisory_xact_lock(60430416)');
     const manifest=r.manifest as ImportInput,parsed=new Map<string,FontMetadata|Record<string,never>>();
     for(const e of entries){
      if(e.kind==='ttf-static'){
       const m=await inspectFont(files.entryPath(id,e.client_key),options.pythonExecutable?{pythonExecutable:options.pythonExecutable}:{});
       if(m.sha256!==e.sha256||m.byteLength!==e.byte_length)fontError('FONT_HASH_MISMATCH');
       parsed.set(e.client_key,m);
      }else{
       const b=await files.readStaged(id,e.client_key);
       if(b.length!==e.byte_length||fingerprintBytes(b)!==e.sha256)fontError('FONT_HASH_MISMATCH');
       try{const license=new TextDecoder('utf-8',{fatal:true}).decode(b);if(!license.trim()||license.includes('\u0000'))throw Error();}catch{fontError('INVALID_FONT_LICENSE');}
       parsed.set(e.client_key,{});
      }
     }
     if(manifest.files.some(f=>!manifest.sourceEvidence.some(s=>s.clientKey===f.clientKey)))fontError('FONT_PROVENANCE_REQUIRED');
     for(const hash of [...new Set<string>(entries.map(e=>e.sha256))].sort())await lockHash(c,hash);
     const assets=new Map<string,string>();
     for(const e of entries){
      const published=await files.promote(files.entryPath(id,e.client_key),e.sha256);if(published.created)created.push(published.storageKey);
      const metadata=parsed.get(e.client_key)!;
      let asset=(await c.query('SELECT * FROM font_assets WHERE sha256=$1',[e.sha256])).rows[0];
      if(asset){if(asset.byte_length!==e.byte_length||asset.format!==e.kind)fontError('FONT_ASSET_CONFLICT');}
      else{asset={id:randomUUID()};await c.query('INSERT INTO font_assets(id,sha256,byte_length,format,storage_key,parsed_metadata) VALUES($1,$2,$3,$4,$5,$6)',[asset.id,e.sha256,e.byte_length,e.kind,published.storageKey,JSON.stringify(metadata)]);}
      assets.set(e.client_key,asset.id);await c.query('UPDATE font_import_files SET asset_id=$3 WHERE import_id=$1 AND client_key=$2',[id,e.client_key,asset.id]);
     }
     const output:InspectedFile[]=[];
     for(const f of manifest.files){
      const source=manifest.sourceEvidence.find(s=>s.clientKey===f.clientKey)!,sourceEvidenceId=randomUUID(),assetId=assets.get(f.clientKey)!;
      const metadata={...source,licenseAssetIds:source.licenseClientKeys.map(k=>assets.get(k)!)};
      await c.query('INSERT INTO font_source_evidence(id,import_id,client_key,asset_id,metadata) VALUES($1,$2,$3,$4,$5)',[sourceEvidenceId,id,f.clientKey,assetId,JSON.stringify(metadata)]);
      output.push({clientKey:f.clientKey,assetId,sourceEvidenceId,sha256:f.sha256,metadata:parsed.get(f.clientKey) as FontMetadata});
     }
     const result:Inspection={id,revision:r.revision+1,state:'inspected',files:output};
     await c.query("UPDATE font_imports SET state='inspected',revision=revision+1,inspection=$2,updated_at=now() WHERE id=$1",[id,JSON.stringify(result)]);
     await audit(c,principal,'import-inspect',input,{importId:id,count:output.length});return result;
    });}catch(error){
     // Still holding all hash locks: no successful importer can acquire a file we remove.
     for(const key of created)await files.removeAsset(key);throw error;
    }
   });
  },
  async stageRelease(input:ReleaseInput){
   object(input,['requestId','reason','familyId','version','importId','languageScope','faceBindings']);mutation(input);
   if(!UUID.test(input.familyId)||!UUID.test(input.importId)||!Number.isSafeInteger(input.version)||input.version<1||input.version>2147483647||!Array.isArray(input.languageScope)||!input.languageScope.length||input.languageScope.some(x=>!['th','en'].includes(x))||new Set(input.languageScope).size!==input.languageScope.length||!Array.isArray(input.faceBindings)||!input.faceBindings.length||input.faceBindings.length>FONT_LIMITS.files)fontError('INVALID_FONT_INPUT');
   for(const b of input.faceBindings){object(b,['assetId','sourceEvidenceId','sourceWeight','approvedWeight','style']);if(!UUID.test(b.assetId)||!UUID.test(b.sourceEvidenceId)||!weight(b.sourceWeight)||!weight(b.approvedWeight)||!['normal','italic'].includes(b.style))fontError('INVALID_FONT_INPUT');}
   return transaction(pool,c=>receipt(c,principal,'stage',input.familyId,input,async()=>{
    const family=(await c.query('SELECT * FROM font_families WHERE id=$1 FOR UPDATE',[input.familyId])).rows[0];if(!family)fontError('FONT_FAMILY_NOT_FOUND');
    const imported=await owned(c,input.importId);if(imported.state!=='inspected')fontError('FONT_UPLOAD_INCOMPLETE');
    const faces:any[]=[],issues:{code:string;path:string}[]=[],slots=new Set<string>(),assetIds=new Set<string>();
    for(const [index,b] of input.faceBindings.entries()){
     const row=(await c.query('SELECT a.*,e.metadata AS source FROM font_assets a JOIN font_source_evidence e ON e.asset_id=a.id WHERE a.id=$1 AND e.id=$2 AND e.import_id=$3',[b.assetId,b.sourceEvidenceId,input.importId])).rows[0];
     if(!row||row.format!=='ttf-static')fontError('FONT_PROVENANCE_REQUIRED');
     const m=row.parsed_metadata as FontMetadata,s=row.source as SourceEvidence&{licenseAssetIds:string[]};
     if(m.style!==b.style||s.sourceWeight!==b.sourceWeight||!family.internal_names.includes(m.names.family))fontError('FONT_BINDING_CONFLICT');
     if(!await files.verify(row.storage_key,row.sha256,row.byte_length))fontError('FONT_ASSET_UNAVAILABLE');
     if(b.approvedWeight!==null){const slot=b.approvedWeight+':'+b.style;if(slots.has(slot))fontError('FONT_FACE_CONFLICT');slots.add(slot);}
     if(assetIds.has(b.assetId))fontError('FONT_FACE_CONFLICT');assetIds.add(b.assetId);
     if(b.approvedWeight===null||b.sourceWeight===null||m.rawWeight!==b.sourceWeight||b.approvedWeight!==b.sourceWeight)issues.push({code:'FONT_WEIGHT_REVIEW_REQUIRED',path:'/faceBindings/'+index});
     faces.push({...b,rawWeight:m.rawWeight,sha256:row.sha256,source:s});
    }
    if(!slots.has('400:normal'))issues.push({code:'FONT_REGULAR_400_REQUIRED',path:'/faceBindings'});
    const manifest={familyId:input.familyId,languageScope:[...input.languageScope].sort(),faces:faces.map(f=>({sha256:f.sha256,rawWeight:f.rawWeight,sourceWeight:f.sourceWeight,approvedWeight:f.approvedWeight,style:f.style,source:{provider:f.source.provider,locator:f.source.locator,metadataHash:f.source.metadataHash,fileHashBinding:f.source.fileHashBinding,licenseAssetIds:[...f.source.licenseAssetIds].sort()}})).sort((a,b)=>canonical(a)<canonical(b)?-1:1)};
    const digest=fingerprint(manifest),prior=(await c.query('SELECT id,manifest_digest FROM font_releases WHERE family_id=$1 AND version=$2',[input.familyId,input.version])).rows[0];
    if(prior&&prior.manifest_digest!==digest)fontError('FONT_RELEASE_CONFLICT');
    const same=(await c.query('SELECT id FROM font_releases WHERE family_id=$1 AND manifest_digest=$2',[input.familyId,digest])).rows[0];
    if(same){await audit(c,principal,'release-reuse',input,{releaseId:same.id},same.id);return {...await getReleaseIn(c,same.id),existing:true};}
    const id=randomUUID();await c.query('INSERT INTO font_releases(id,family_id,version,manifest_digest,language_scope,issues) VALUES($1,$2,$3,$4,$5,$6)',[id,input.familyId,input.version,digest,JSON.stringify(input.languageScope),JSON.stringify(issues)]);
    for(const f of faces)await c.query('INSERT INTO font_faces(id,release_id,asset_id,source_evidence_id,raw_weight,source_weight,approved_weight,style) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),id,f.assetId,f.sourceEvidenceId,f.rawWeight,f.sourceWeight,f.approvedWeight,f.style]);
    await audit(c,principal,'release-stage',input,{manifestDigest:digest},id);return {...await getReleaseIn(c,id),existing:false};
   }));
  },
  async getRelease(id:string){return transaction(pool,c=>getReleaseIn(c,id));},
  async recoverFiles(){
   // Reconcile CAS entries under the same hash lock used by importers, including uncertain commits.
   let removed=0;
   for(const key of await files.assetKeys())await transaction(pool,async c=>{await lockHash(c,key.slice(0,64));const exists=(await c.query('SELECT 1 FROM font_assets WHERE storage_key=$1',[key])).rowCount;if(!exists){await files.removeAsset(key);removed++;}});
   let stagedRemoved=0;
   for(const id of await files.stagingIds())await transaction(pool,async c=>{
    const known=(await c.query('SELECT 1 FROM font_imports WHERE id=$1',[id])).rowCount;
    if(!known){stagedRemoved+=await files.clearStaging(id);return;}
    const row=(await c.query('SELECT state,expires_at FROM font_imports WHERE id=$1 FOR UPDATE SKIP LOCKED',[id])).rows[0];
    if(row&&(row.state==='inspected'||new Date(row.expires_at).getTime()<=Date.now()))stagedRemoved+=await files.clearStaging(id);
   });
   return {removed,stagedRemoved};
  }
 };
}
import {createHash} from 'node:crypto';
const fingerprintBytes=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
