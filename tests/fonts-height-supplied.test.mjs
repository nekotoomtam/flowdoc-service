import {beforeAll,afterAll,it,expect} from 'vitest';
import {calculateFontHeightAdjustment,FONT_HEIGHT_METHOD} from '@flowdoc/core';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createFontLibrary} from '../dist/fonts/service.js';
import {createFontHeightProfiles} from '../dist/fonts/heightProfiles.js';
import {inspectFont} from '../dist/fonts/inspection.js';
import {fingerprint} from '../dist/fonts/repository.js';
import {createFontLifecycle} from '../dist/fonts/lifecycle.js';
import {mutation as m,stageSet,releaseSet} from './fontLifecycleFixture.mjs';
const db=isolatedDatabase(),pool=db.pool;let root;
const sha=b=>createHash('sha256').update(b).digest('hex');
beforeAll(async()=>{await db.setup();expect((await migrate(pool)).ok).toBe(true);root=await mkdtemp(join(tmpdir(),'height-supplied-'));});
afterAll(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
it.runIf(!!process.env.HEIGHT_SUPPLIED_DIR)('imports the supplied TH custom set and six Google families, binds reviewed profiles without changing release manifests',async()=>{
 const dir=process.env.HEIGHT_SUPPLIED_DIR,lib=await createFontLibrary({pool,root,principal:'font-test-admin'}),profiles=createFontHeightProfiles({pool,root,principal:'font-test-admin'}),summary=[];
 const sets=[
  {key:'thsarabunnew',provider:'custom',files:['THSarabunNew/THSarabunNew.ttf','THSarabunNew/THSarabunNew Bold.ttf','THSarabunNew/THSarabunNew Italic.ttf','THSarabunNew/THSarabunNew BoldItalic.ttf'],top:'400'},
  {key:'sarabun',files:['IBM_Plex_Sans_Thai,Pridi,Sarabun/Sarabun/Sarabun-Regular.ttf'],top:'586'},
  {key:'ibm-plex-sans-thai',files:['IBM_Plex_Sans_Thai,Pridi,Sarabun/IBM_Plex_Sans_Thai/IBMPlexSansThai-Regular.ttf']},
  {key:'pridi',files:['IBM_Plex_Sans_Thai,Pridi,Sarabun/Pridi/Pridi-Regular.ttf']},
  {key:'noto-sans-thai-looped',files:['Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Noto_Sans_Thai_Looped/static/NotoSansThaiLooped-Regular.ttf'],top:'562'},
  {key:'noto-serif-thai',files:['Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Noto_Serif_Thai/static/NotoSerifThai-Regular.ttf'],top:'554'},
  {key:'prompt',files:['Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Prompt/Prompt-Regular.ttf'],top:'535'}];
 for(const set of sets){
  const paths=set.files.map(p=>join(dir,p)),metadata=await Promise.all(paths.map(p=>inspectFont(p))),bytes=await Promise.all(paths.map(p=>readFile(p)));
  const custom=set.provider==='custom';let folder=dirname(paths[0]);if(folder.endsWith('static'))folder=dirname(folder);
  const license=custom?Buffer.from(metadata[0].names.license,'utf8'):await readFile(join(folder,'OFL.txt'));
  const provenance={sourceName:metadata[0].names.family,sourceVersion:metadata[0].fileVersion,obtainedFrom:'Owner supplied download',rightsNote:'License extracted verbatim from name ID 13 of '+sha(bytes[0])};
  const evidence=bytes.map((b,i)=>({clientKey:'f'+i,provider:custom?'custom':'google-fonts',locator:custom?'urn:flowdoc:custom:'+set.key:'https://fonts.google.com/specimen/'+encodeURIComponent(metadata[0].names.family),retrievedAt:'2026-10-16T00:00:00Z',metadataHash:fingerprint(provenance),fileHashBinding:sha(b),sourceWeight:null,licenseClientKeys:['license'],...(custom?{providerFamilyKey:set.key,provenance}:{})}));
  const family=await lib.createFamily({requestId:randomUUID(),reason:'Supplied file verification',displayName:metadata[0].names.family,internalNames:[...new Set(metadata.map(x=>x.names.family))],sourceIdentity:{provider:custom?'custom':'google-fonts',providerFamilyKey:set.key}});
  const imported=await lib.createImport({requestId:randomUUID(),reason:'Supplied verification',files:bytes.map((b,i)=>({clientKey:'f'+i,byteLength:b.length,sha256:sha(b)})),licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:sha(license)}],sourceEvidence:evidence});
  for(const [i,b] of bytes.entries())await lib.receive(imported.id,'f'+i,(async function*(){yield b;})());await lib.receive(imported.id,'license',(async function*(){yield license;})());
  const inspected=await lib.inspectImport(imported.id,m(0)),release=await lib.stageRelease({requestId:randomUUID(),reason:'Supplied verification',familyId:family.id,version:1,importId:imported.id,languageScope:['th','en'],faceBindings:inspected.files.map(f=>{const meta=metadata[Number(f.clientKey.slice(1))];return {assetId:f.assetId,sourceEvidenceId:f.sourceEvidenceId,sourceWeight:null,approvedWeight:meta.rawWeight,style:meta.style,conflictResolution:{reason:'Approve file-declared weight; upstream weight unavailable',sourceWeight:null,approvedWeight:meta.rawWeight}};})});
  expect(release.issues).toEqual([]);const before=(await pool.query('SELECT * FROM font_releases WHERE id=$1',[release.id])).rows;
  const profile=await profiles.measure(release.id,m(release.revision,{manifestDigest:release.manifestDigest}));
  expect(profile.outcome).toBe('measured');if(set.top)expect(profile.topDesign).toBe(set.top);
  if(custom)expect(profile.referenceId).toBe('th-sarabun-new-1.35-regular');
  await profiles.approve(profile.id,m(release.revision,{profileDigest:profile.profileDigest}));await profiles.assign(release.id,m(0,{profileId:profile.id,profileDigest:profile.profileDigest}));
  expect((await pool.query('SELECT * FROM font_releases WHERE id=$1',[release.id])).rows).toEqual(before);
  const adjusted=calculateFontHeightAdjustment({fontSizePt:16,sourceMetric:{methodId:FONT_HEIGHT_METHOD,unitsPerEm:1000,topDesign:'400'},targetMetric:{methodId:profile.methodId,unitsPerEm:profile.unitsPerEm,topDesign:profile.topDesign}});
  const expected={thsarabunnew:16,sarabun:10.921502,'ibm-plex-sans-thai':11.721612,pridi:11.764706,'noto-sans-thai-looped':11.3879,'noto-serif-thai':11.552347,prompt:11.962617};
  expect(adjusted).toEqual({ok:true,value:{fontSizePt:expected[set.key],methodId:FONT_HEIGHT_METHOD}});
  summary.push({family:set.key,faces:bytes.length,top:profile.topDesign,hash:profile.sha256,profileId:profile.id,adjustedPt:adjusted.value.fontSizePt});
 }
 console.log(JSON.stringify({suppliedHeightProfiles:summary}));
},120000);
it('adds profiles to real active and retired releases without changing lifecycle state, manifest or legacy rights',async()=>{
 const f=await releaseSet(pool,root,await stageSet(pool,root)),profiles=createFontHeightProfiles({pool,root,principal:'font-test-admin'}),life=createFontLifecycle({pool,root,principal:'font-test-admin'});
 for(const state of ['active','retired']){
  if(state==='retired')await life.retire(f.id,m(f.revision));
  const before=(await pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id])).rows[0];
  const p=await profiles.measure(f.id,m(before.revision,{manifestDigest:f.manifestDigest}));
  await profiles.approve(p.id,m(before.revision,{profileDigest:p.profileDigest}));
  expect((await pool.query('SELECT * FROM font_releases WHERE id=$1',[f.id])).rows[0]).toEqual(before);
 }
},120000);
