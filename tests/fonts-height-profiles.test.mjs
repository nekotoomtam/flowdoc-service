import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm,cp,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {stageSet,mutation as m} from './fontLifecycleFixture.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createFontLibrary} from '../dist/fonts/service.js';
import {inspectFont} from '../dist/fonts/inspection.js';
import {fingerprint} from '../dist/fonts/repository.js';
import {createServer} from '../dist/http/server.js';
import {createFontAdminClient} from '../dist/fonts/client.js';
const api=await import('../dist/fonts/heightProfiles.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;
let root,profiles;
const sha=b=>createHash('sha256').update(b).digest('hex');
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'font-height-'));});
afterAll(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
const manager=()=>{expect(api.createFontHeightProfiles).toBeTypeOf('function');return api.createFontHeightProfiles({pool,root,principal:'font-test-admin'});};
it('measures exact unhinted curve bounds, composites and missing Bo without rejecting valid TTF',async()=>{
 const script=`from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
import sys
for kind in ['curve','composite','missing']:
 f=FontBuilder(1000,isTTF=True); names=['.notdef','space','bo','comp']; f.setupGlyphOrder(names)
 glyphs={}
 for name in names:
  p=TTGlyphPen(None)
  if name=='bo':p.moveTo((0,0));p.qCurveTo((100,1000),(200,0));p.closePath()
  if name=='comp':p=TTGlyphPen({'bo':None});p.addComponent('bo',(0.5,0,0,0.5,0,10))
  glyphs[name]=p.glyph()
 f.setupCharacterMap({32:'space',65:'bo',**({0x0e1a:'comp' if kind=='composite' else 'bo'} if kind!='missing' else {})})
 f.setupGlyf(glyphs);f.setupHorizontalMetrics({n:(500,0) for n in names});f.setupHorizontalHeader(ascent=800,descent=-200)
 f.setupNameTable({'familyName':'Height Fixture','styleName':'Regular','uniqueFontIdentifier':'Height Fixture '+kind,'fullName':'Height Fixture','psName':'HeightFixture'})
 f.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=1000,usWinDescent=200,usWeightClass=400)
 f.setupPost();f.setupMaxp();f.save(sys.argv[1]+'/'+kind+'.ttf')
`;
 execFileSync(process.env.PYTHON_EXECUTABLE??'python',['-c',script,root],{windowsHide:true});
 const a=await inspectFont(join(root,'curve.ttf'),{includeHeightMetric:true}),b=await inspectFont(join(root,'composite.ttf'),{includeHeightMetric:true}),c=await inspectFont(join(root,'missing.ttf'),{includeHeightMetric:true});
 expect(a.heightMetric).toMatchObject({methodId:'thai-bo-baseline-top-v1',outcome:'measured',unitsPerEm:1000,baselineDesign:'0',topDesign:'500'});
 expect(b.heightMetric.topDesign).toBe('260');
 expect(c.heightMetric).toMatchObject({outcome:'unavailable',reason:'GLYPH_MISSING'});
 expect(a.heightMetric.toolVersion).toBeTruthy();
 expect((await inspectFont(join(root,'curve.ttf'))).heightMetric).toBeUndefined();
});
it('stores immutable hash-bound profiles; retries reuse results, approval and assignments use CAS',async()=>{
 const p=manager(),f=await stageSet(pool,root),before=await pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id]);
 const input=m(f.revision,{manifestDigest:f.manifestDigest}),a=await p.measure(f.id,input),again=await p.measure(f.id,input);
 expect(again).toEqual(a);expect(a).toMatchObject({releaseId:f.id,releaseManifestDigest:f.manifestDigest,outcome:'measured',topDesign:'586',unitsPerEm:1000});
 expect((await p.measure(f.id,m(f.revision,{manifestDigest:f.manifestDigest}))).id).toBe(a.id);
 expect((await p.get(a.id)).profileDigest).toBe(a.profileDigest);
 await expect(p.assign(f.id,m(0,{profileId:a.id,profileDigest:a.profileDigest}))).rejects.toMatchObject({code:'FONT_HEIGHT_PROFILE_UNREVIEWED'});
 await p.approve(a.id,m(f.revision,{profileDigest:a.profileDigest}));
 const assigned=await p.assign(f.id,m(0,{profileId:a.id,profileDigest:a.profileDigest}));expect(assigned.revision).toBe(1);
 await expect(p.assign(f.id,m(0,{profileId:a.id,profileDigest:a.profileDigest}))).rejects.toMatchObject({code:'STALE_CURRENT'});
 await expect(pool.query("UPDATE font_height_profiles SET top_design='123' WHERE id=$1",[a.id])).rejects.toThrow();
 await expect(pool.query('DELETE FROM font_height_profiles WHERE id=$1',[a.id])).rejects.toThrow();
 await expect(pool.query('DELETE FROM font_height_profile_reviews WHERE profile_id=$1',[a.id])).rejects.toThrow();
 await p.revoke(a.id,m(f.revision,{profileDigest:a.profileDigest}));
 expect((await p.get(a.id)).reviewStatus).toBe('revoked');
 await expect(p.assign(f.id,m(1,{profileId:a.id,profileDigest:a.profileDigest}))).rejects.toMatchObject({code:'FONT_HEIGHT_PROFILE_UNREVIEWED'});
 expect((await pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id])).rows).toEqual(before.rows);
 // A new service instance reads persisted data rather than process memory.
 expect((await manager().get(a.id)).id).toBe(a.id);
});
async function customImport(lib,{provider='custom',metadataHash,provenance,sourceWeight=400}={}){
 const bytes=await readFile('node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf'),license=await readFile('node_modules/@flowdoc/core/assets/fonts/OFL.txt');
 provenance??={sourceName:'Supplied Sarabun fixture',sourceVersion:'1',obtainedFrom:'User supplied fixture',rightsNote:'Original OFL attached'};
 const source={clientKey:'f',provider,locator:provider==='custom'?'urn:flowdoc:custom:supplied-sarabun':'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00Z',metadataHash:metadataHash??fingerprint(provenance),fileHashBinding:sha(bytes),sourceWeight,licenseClientKeys:['l'],...(provider==='custom'?{provenance,providerFamilyKey:'supplied-sarabun'}:{})};
 const input={requestId:randomUUID(),reason:'Custom source fixture',files:[{clientKey:'f',byteLength:bytes.length,sha256:sha(bytes)}],licenseFiles:[{clientKey:'l',byteLength:license.length,sha256:sha(license)}],sourceEvidence:[source]};
 const i=await lib.createImport(input);for(const [k,b] of [['f',bytes],['l',license]])await lib.receive(i.id,k,(async function*(){yield b;})());
 return {inspection:await lib.inspectImport(i.id,m(0)),input};
}
it('accepts custom provenance with licenses; keeps Google imports and rejects forged source hashes/provider swaps',async()=>{
 const lib=await createFontLibrary({pool,root,principal:'font-test-admin'});
 const family=await lib.createFamily({requestId:randomUUID(),reason:'Custom',displayName:'Supplied Sarabun',internalNames:['Sarabun'],sourceIdentity:{provider:'custom',providerFamilyKey:'supplied-sarabun'}});
 const {inspection}=await customImport(lib),face=inspection.files[0];
 const request={requestId:randomUUID(),reason:'Custom',familyId:family.id,version:1,importId:inspection.id,languageScope:['th'],faceBindings:[{assetId:face.assetId,sourceEvidenceId:face.sourceEvidenceId,sourceWeight:400,approvedWeight:400,style:'normal'}]};
 const release=await lib.stageRelease(request);expect(release.state).toBe('preparing');
 await expect(customImport(lib,{metadataHash:'0'.repeat(64)})).rejects.toMatchObject({code:'FONT_PROVENANCE_REQUIRED'});
 await expect(customImport(lib,{provenance:{sourceName:'x',sourceVersion:'1',obtainedFrom:'C:/private/file.ttf',rightsNote:'x'}})).rejects.toMatchObject({code:'INVALID_FONT_INPUT'});
 const google=(await stageSet(pool,root)).candidate;
 await expect(lib.stageRelease({...request,requestId:randomUUID(),familyId:google.familyId,version:2})).rejects.toMatchObject({code:'FONT_BINDING_CONFLICT'});
 const assetCount=await pool.query("SELECT count(*) FROM font_assets WHERE sha256=$1",[face.sha256]);expect(assetCount.rows[0].count).toBe('1');
 const withNull=await customImport(lib,{sourceWeight:null});
 const x=withNull.inspection.files[0];const pending=await lib.stageRelease({...request,requestId:randomUUID(),version:2,importId:withNull.inspection.id,faceBindings:[{assetId:x.assetId,sourceEvidenceId:x.sourceEvidenceId,sourceWeight:null,approvedWeight:400,style:'normal'}]});
 expect(pending.issues.some(i=>i.code==='FONT_WEIGHT_REVIEW_REQUIRED')).toBe(true);
});
it('invalidates profiles after preparing manifest changes, rejects tampered bytes and cross-release assignments',async()=>{
 const p=manager(),a=await stageSet(pool,root),b=await stageSet(pool,root),profile=await p.measure(a.id,m(a.revision,{manifestDigest:a.manifestDigest}));
 await p.approve(profile.id,m(a.revision,{profileDigest:profile.profileDigest}));
 await expect(p.assign(b.id,m(0,{profileId:profile.id,profileDigest:profile.profileDigest}))).rejects.toMatchObject({code:'FONT_BINDING_CONFLICT'});
 const lib=await createFontLibrary({pool,root,principal:'font-test-admin'});
 await lib.stageRelease({...a.candidate,requestId:randomUUID(),languageScope:['th']},{id:a.id,expectedRevision:a.revision});
 await expect(p.approve(profile.id,m(1,{profileDigest:profile.profileDigest}))).rejects.toMatchObject({code:'FONT_HEIGHT_PROFILE_STALE'});
 const separateRoot=await mkdtemp(join(root,'tampered-')),c=await stageSet(pool,separateRoot),asset=(await pool.query('SELECT a.storage_key FROM font_faces f JOIN font_assets a ON a.id=f.asset_id WHERE f.release_id=$1',[c.id])).rows[0];
 // Shared global asset content is deduplicated, so copy the valid bytes into this fixture root first.
 const keys=await readdir(join(separateRoot,'assets'));expect(keys.length).toBeGreaterThan(0);
 await writeFile(join(separateRoot,'assets',asset.storage_key),'tampered');
 const bad=api.createFontHeightProfiles({pool,root:separateRoot,principal:'font-test-admin'});
 await expect(bad.measure(c.id,m(c.revision,{manifestDigest:c.manifestDigest}))).rejects.toMatchObject({code:'FONT_ASSET_UNAVAILABLE'});
});
it('keeps new profile routes administrator-only and binds actor to authentication',async()=>{
 const admin='a'.repeat(40),author='b'.repeat(40),app=createServer({pool,outputs:{},isReady:()=>true,fontStorageRoot:root,fontAdmin:{token:admin,principal:'route-admin'},authoring:{token:author,principal:'writer'}});
 await app.ready();try{
  const f=await stageSet(pool,root),route=`/admin/fonts/releases/${f.id}/height-profiles`,body=m(f.revision,{manifestDigest:f.manifestDigest});
  expect((await app.inject({method:'POST',url:route,headers:{authorization:'Bearer '+author},payload:body})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:route,headers:{authorization:'Bearer '+admin},payload:{...body,actor:'forged'}})).statusCode).toBe(422);
  const created=await app.inject({method:'POST',url:route,headers:{authorization:'Bearer '+admin},payload:body});expect(created.statusCode,created.body).toBe(200);
  const id=created.json().value.id;
  const assignUrl=`/admin/fonts/releases/${f.id}/height-profile`,assignBody=m(0,{profileId:id,profileDigest:created.json().value.profileDigest});
  expect((await app.inject({method:'PUT',url:assignUrl,headers:{authorization:'Bearer '+author},payload:assignBody})).statusCode).toBe(403);
  expect((await app.inject({method:'PUT',url:assignUrl,headers:{authorization:'Bearer '+admin},payload:assignBody})).statusCode).toBe(422);
  for(const obtainedFrom of ['file:///private/font.ttf','https://user:password@example.test/font','/mnt/c/Users/owner/private/font.ttf','/opt/private/font.ttf','downloaded(C:/Users/owner/private/font.ttf)'])await expect(customImport(await createFontLibrary({pool,root,principal:'font-test-admin'}),{provenance:{sourceName:'x',sourceVersion:'1',obtainedFrom,rightsNote:'x'}})).rejects.toMatchObject({code:'INVALID_FONT_INPUT'});
  for(const suffix of ['', '/approve','/revoke'])expect((await app.inject({method:suffix?'POST':'GET',url:'/admin/fonts/height-profiles/'+id+suffix,headers:{authorization:'Bearer '+author},...(suffix?{payload:m(0)}:{})})).statusCode).toBe(403);
  const client=createFontAdminClient({baseUrl:'http://127.0.0.1:3000',token:admin,fetch:async(url,init)=>{
   const r=await app.inject({method:init.method,url:new URL(url).pathname,headers:init.headers,...(init.body?{payload:init.body}:{})});return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});
  }});
  const request={id,...m(0,{profileDigest:created.json().value.profileDigest})};
  expect(await client.execute('height-approve',request)).toMatchObject({ok:true,value:{reviewStatus:'approved'}});
  expect(await client.execute('height-assign',{id:f.id,...m(0,{profileId:id,profileDigest:created.json().value.profileDigest})})).toMatchObject({ok:true,value:{revision:1}});
  expect(await client.execute('height-show',{id})).toMatchObject({ok:true,value:{id,reviewStatus:'approved'}});
  expect(await client.execute('height-revoke',{...request,requestId:randomUUID()})).toMatchObject({ok:true,value:{reviewStatus:'revoked'}});
  expect((await pool.query("SELECT actor FROM font_audit_events WHERE action='height-measure' AND summary->>'profileId'=$1",[id])).rows).toEqual([{actor:'route-admin'}]);
 }finally{await app.close();}
});
it('stores missing-Regular diagnostics without making them approvable',async()=>{
 const p=manager(),f=await stageSet(pool,root,{files:['Sarabun-Bold.ttf'],weights:[700]});
 const diagnostic=await p.measure(f.id,m(f.revision,{manifestDigest:f.manifestDigest}));
 expect(diagnostic).toMatchObject({outcome:'unavailable',reason:'REGULAR_MISSING',topDesign:null,regularFaceId:null});
 await expect(p.approve(diagnostic.id,m(f.revision,{profileDigest:diagnostic.profileDigest}))).rejects.toMatchObject({code:'FONT_HEIGHT_PROFILE_UNAVAILABLE'});
});
it('upgrades a populated 018 database without changing assets, releases or legacy drafts',async()=>{
 const old=isolatedDatabase(),folder=await mkdtemp(join(root,'migrations-'));
 await old.setup();try{
  for(const name of (await readdir('migrations')).filter(n=>/^\d{3}_.*\.sql$/.test(n)&&Number(n.slice(0,3))<=18))await cp(join('migrations',name),join(folder,name));
  expect((await migrate(old.pool,folder)).ok).toBe(true);
  const f=await stageSet(old.pool,root),assets=(await old.pool.query('SELECT * FROM font_assets ORDER BY id')).rows,release=(await old.pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id])).rows;
  const app=createServer({pool:old.pool,outputs:{},isReady:()=>true,authoring:{token:'d'.repeat(40),principal:'legacy-writer'},fontStorageRoot:root});await app.ready();
  let draft;
  try{
   const headers={authorization:'Bearer '+'d'.repeat(40)},created=await app.inject({method:'POST',url:'/authoring/drafts',headers,payload:{name:'Retained legacy',docKey:'height-legacy',idempotencyKey:'legacy-create'}});
   expect(created.statusCode,created.body).toBe(201);const id=created.json().value.templateId;
   const definition=JSON.parse(await readFile('examples/area-document-template.json','utf8'));definition.templateId=id;definition.docKey='height-legacy';definition.version=1;
   const saved=await app.inject({method:'PUT',url:'/authoring/drafts/'+id,headers,payload:{definition,expectedRevision:0,idempotencyKey:'legacy-save'}});expect(saved.statusCode,saved.body).toBe(200);draft=saved.json().value;
   expect((await migrate(old.pool)).value.applied).toEqual(['019_font_height_profiles.sql']);
   expect((await migrate(old.pool)).value.applied).toEqual([]);
   const read=(await app.inject({method:'GET',url:'/authoring/drafts/'+id,headers})).json().value;
   expect(read.definition).toEqual(draft.definition);expect(read.fingerprint).toBe(draft.fingerprint);expect(read.revision).toBe(draft.revision);
  }finally{await app.close();}
  expect((await old.pool.query('SELECT * FROM font_assets ORDER BY id')).rows).toEqual(assets);
  expect((await old.pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id])).rows).toEqual(release);
  const p=api.createFontHeightProfiles({pool:old.pool,root,principal:'font-test-admin'}),profile=await p.measure(f.id,m(f.revision,{manifestDigest:f.manifestDigest}));
  expect(profile.topDesign).toBe('586');
 }finally{await old.close();}
});
