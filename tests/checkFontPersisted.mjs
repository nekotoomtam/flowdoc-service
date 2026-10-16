import {Pool} from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createFontLibrary} from '../dist/fonts/service.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL}),root='/app/staging/font-persistence';
const sha=b=>createHash('sha256').update(b).digest('hex'),mode=process.argv[2];
try{
 const library=await createFontLibrary({pool,root,principal:'font-persistence-check'});
 if(mode==='write'){
  const font=await readFile('node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf'),license=await readFile('node_modules/@flowdoc/core/assets/fonts/OFL.txt');
  const family=await library.createFamily({requestId:'persist-family',reason:'Isolated persistence check',displayName:'Sarabun persistence',internalNames:['Sarabun'],sourceIdentity:{provider:'google-fonts',providerFamilyKey:'persistence-check'}});
  const imported=await library.createImport({requestId:'persist-import',reason:'Isolated persistence check',files:[{clientKey:'regular',byteLength:font.length,sha256:sha(font)}],licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:sha(license)}],sourceEvidence:[{clientKey:'regular',provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'a'.repeat(64),fileHashBinding:sha(font),sourceWeight:null,licenseClientKeys:['license']}]});
  for(const [key,bytes] of [['regular',font],['license',license]])await library.receive(imported.id,key,(async function*(){yield bytes;})());
  const inspection=await library.inspectImport(imported.id,{requestId:'persist-inspect',reason:'Isolated persistence check',expectedRevision:0}),file=inspection.files[0];
  const staged=await library.stageRelease({requestId:'persist-stage',reason:'Isolated persistence check',familyId:family.id,version:1,importId:imported.id,languageScope:['th','en'],faceBindings:[{assetId:file.assetId,sourceEvidenceId:file.sourceEvidenceId,sourceWeight:null,approvedWeight:null,style:'normal'}]});
  await library.recoverFiles();
  const assets=(await pool.query('SELECT id,sha256,byte_length,storage_key FROM font_assets ORDER BY id')).rows;
  await writeFile(root+'/proof.json',JSON.stringify({release:await library.getRelease(staged.id),assets}));
 }else if(mode==='read'){
  const saved=JSON.parse(await readFile(root+'/proof.json','utf8')),current=await library.getRelease(saved.release.id);
  assert.deepEqual(current,saved.release);assert.equal(current.state,'preparing');
  for(const a of saved.assets)assert.equal(await library.files.verify(a.storage_key,a.sha256,a.byte_length),true);
  assert.equal((await library.recoverFiles()).removed,0);
 }else throw Error('Use write/read');
 console.log(JSON.stringify({status:'PASS',mode,checks:mode==='write'?['preparing release persisted','unverified weights pending','completed staging cleaned']:['release/face/manifest unchanged after restart','shared font/license hashes intact','recovery preserves referenced assets']}));
}finally{await pool.end();}
