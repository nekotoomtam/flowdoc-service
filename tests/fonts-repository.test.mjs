import {beforeAll,afterAll,it,expect} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../dist/db/migrate.js';
const api=await import('../dist/fonts/service.js').catch(()=>({}));
const db=isolatedDatabase(),pool=db.pool;
let root,lib;
const sha=b=>createHash('sha256').update(b).digest('hex');
const unwrap=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const regular=()=>readFile(new URL('../node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf',import.meta.url));
const evidence=(key,b)=>({clientKey:key,provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'a'.repeat(64),fileHashBinding:sha(b),sourceWeight:400,licenseClientKeys:['license']});
beforeAll(async()=>{await db.setup();unwrap(await migrate(pool));root=await mkdtemp(join(tmpdir(),'font-library-'));});
afterAll(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
async function library(){expect(api.createFontLibrary).toBeTypeOf('function');return api.createFontLibrary({pool,root,principal:'font-admin'});}
async function intake(l,b,key='regular',retrievedAt='2026-10-16T00:00:00.000Z'){
 b??=await regular();
 const license=await readFile(new URL('../node_modules/@flowdoc/core/assets/fonts/OFL.txt',import.meta.url));
 const i=await l.createImport({requestId:randomUUID(),reason:'test',files:[{clientKey:key,byteLength:b.length,sha256:sha(b)}],licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:sha(license)}],sourceEvidence:[{...evidence(key,b),retrievedAt}]});
 await l.receive(i.id,key,(async function*(){yield b;})());await l.receive(i.id,'license',(async function*(){yield license;})());
 return l.inspectImport(i.id,{requestId:randomUUID(),expectedRevision:0,reason:'inspect'});
}
it('creates audited preparing releases, stores three weights, deduplicates concurrent imports and exact sets',async()=>{
 lib=await library();const family=await lib.createFamily({requestId:randomUUID(),reason:'test',displayName:'Sarabun',internalNames:['Sarabun'],sourceIdentity:{provider:'google-fonts',providerFamilyKey:'sarabun'}});
 const [a,b]=await Promise.all([intake(lib),intake(lib,await regular(),'renamed','2026-10-16T01:00:00.000Z')]);
 expect(a.files[0].assetId).toBe(b.files[0].assetId);
 const candidate={requestId:randomUUID(),reason:'stage',familyId:family.id,version:1,importId:a.id,languageScope:['th','en'],faceBindings:[{assetId:a.files[0].assetId,sourceEvidenceId:a.files[0].sourceEvidenceId,sourceWeight:400,approvedWeight:400,style:'normal'}]};
 const [one,two]=await Promise.all([lib.stageRelease(candidate),lib.stageRelease(candidate)]);
 expect(one.id).toBe(two.id);expect(one.state).toBe('preparing');expect(one.faces[0]).toMatchObject({rawWeight:400,sourceWeight:400,approvedWeight:400});
 const same=await lib.stageRelease({...candidate,requestId:randomUUID(),version:2,importId:b.id,faceBindings:[{...candidate.faceBindings[0],assetId:b.files[0].assetId,sourceEvidenceId:b.files[0].sourceEvidenceId}]});
 expect(same.id).toBe(one.id);expect(same.existing).toBe(true);
 expect((await pool.query('SELECT count(*)::int n FROM font_assets WHERE format=\'ttf-static\'')).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM font_audit_events')).rows[0].n).toBeGreaterThan(2);
 await expect(lib.stageRelease({...candidate,version:3})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await expect(pool.query("UPDATE font_releases SET state='active' WHERE id=$1",[one.id])).rejects.toThrow();
 await expect(pool.query('UPDATE font_assets SET sha256=$1 WHERE id=$2',['0'.repeat(64),a.files[0].assetId])).rejects.toThrow();
 await expect(pool.query('UPDATE font_faces SET raw_weight=500 WHERE release_id=$1',[one.id])).rejects.toThrow();
});
it('keeps conflicting weights pending and never overwrites an existing face with other bytes',async()=>{
 const l=await library(),a=await intake(l);
 const f=await l.createFamily({requestId:randomUUID(),reason:'test',displayName:'Conflict',internalNames:['Sarabun'],sourceIdentity:{provider:'google-fonts',providerFamilyKey:randomUUID()}});
 const base={requestId:randomUUID(),reason:'stage',familyId:f.id,version:1,importId:a.id,languageScope:['th'],faceBindings:[{assetId:a.files[0].assetId,sourceEvidenceId:a.files[0].sourceEvidenceId,sourceWeight:400,approvedWeight:500,style:'normal'}]};
 const r=await l.stageRelease(base);expect(r.issues).toContainEqual(expect.objectContaining({code:'FONT_WEIGHT_REVIEW_REQUIRED'}));
 const bold=await readFile(new URL('../node_modules/@flowdoc/core/assets/fonts/Sarabun-Bold.ttf',import.meta.url)),b=await intake(l,bold);
 await expect(l.stageRelease({...base,requestId:randomUUID(),importId:b.id,faceBindings:[{...base.faceBindings[0],assetId:b.files[0].assetId,sourceEvidenceId:b.files[0].sourceEvidenceId}]})).rejects.toMatchObject({code:'FONT_RELEASE_CONFLICT'});
 expect((await l.getRelease(r.id)).faces[0].assetId).toBe(a.files[0].assetId);
 const next=await l.stageRelease({...base,requestId:randomUUID(),version:2,importId:b.id,faceBindings:[{...base.faceBindings[0],assetId:b.files[0].assetId,sourceEvidenceId:b.files[0].sourceEvidenceId}]});
 expect(next.id).not.toBe(r.id);expect((await l.getRelease(r.id)).faces[0].assetId).toBe(a.files[0].assetId);
});
it('rejects incomplete intake, unauthorized imports, limits and missing provenance without granting a release',async()=>{
 const l=await library();
 await expect(l.createImport({requestId:randomUUID(),reason:'bad',files:[],licenseFiles:[],sourceEvidence:[]})).rejects.toMatchObject({code:'INVALID_FONT_INPUT'});
 const file={clientKey:'r',byteLength:100,sha256:'0'.repeat(64)};
 await expect(l.createImport({requestId:randomUUID(),reason:'limit',files:Array.from({length:65},(_,i)=>({...file,clientKey:'f'+i})),licenseFiles:[],sourceEvidence:[]})).rejects.toMatchObject({code:'FONT_LIMIT_EXCEEDED'});
 await expect(l.createImport({requestId:randomUUID(),reason:'limit',files:Array.from({length:13},(_,i)=>({...file,byteLength:10*1024*1024,clientKey:'f'+i})),licenseFiles:[],sourceEvidence:[]})).rejects.toMatchObject({code:'FONT_LIMIT_EXCEEDED'});
 await expect(l.createImport({requestId:randomUUID(),reason:'duplicate',files:[file,file],licenseFiles:[],sourceEvidence:[]})).rejects.toMatchObject({code:'INVALID_FONT_INPUT'});
 const b=await regular(),i=await l.createImport({requestId:randomUUID(),reason:'incomplete',files:[{clientKey:'r',byteLength:b.length,sha256:sha(b)}],licenseFiles:[],sourceEvidence:[]});
 await expect(l.inspectImport(i.id,{requestId:randomUUID(),expectedRevision:0,reason:'inspect'})).rejects.toMatchObject({code:'FONT_UPLOAD_INCOMPLETE'});
 const other=await api.createFontLibrary({pool,root,principal:'other-admin'});
 await expect(other.getImport(i.id)).rejects.toMatchObject({code:'FONT_IMPORT_NOT_FOUND'});
 await expect(l.receive(i.id,'../escape',(async function*(){yield b;})())).rejects.toThrow();
 await l.receive(i.id,'r',(async function*(){yield b;})());
 await expect(l.inspectImport(i.id,{requestId:randomUUID(),expectedRevision:0,reason:'No source evidence'})).rejects.toMatchObject({code:'FONT_PROVENANCE_REQUIRED'});
});
it('rolls back failed catalog writes and recovers unreferenced immutable files without deleting shared assets',async()=>{
 const l=await library(),before=(await pool.query('SELECT count(*)::int n FROM font_assets')).rows[0].n;
 await pool.query("CREATE FUNCTION fail_font_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$; CREATE TRIGGER fail_font_insert BEFORE INSERT ON font_source_evidence FOR EACH ROW EXECUTE FUNCTION fail_font_insert()");
 const b=await readFile(new URL('../node_modules/@flowdoc/core/assets/fonts/Sarabun-Italic.ttf',import.meta.url));
 await expect(intake(l,b)).rejects.toThrow();
 await pool.query('DROP TRIGGER fail_font_insert ON font_source_evidence; DROP FUNCTION fail_font_insert()');
 expect((await pool.query('SELECT count(*)::int n FROM font_assets')).rows[0].n).toBe(before);
 const fake=Buffer.from('uncommitted bytes'),staged=await l.files.receive(randomUUID(),'orphan',(async function*(){yield fake;})(),{byteLength:fake.length,sha256:sha(fake)});
 const orphan=await l.files.promote(staged.path,sha(fake));
 expect(await l.recoverFiles()).toMatchObject({removed:1});
 expect(await l.files.verify(orphan.storageKey,sha(fake),fake.length)).toBe(false);
 expect((await pool.query('SELECT count(*)::int n FROM font_assets')).rows[0].n).toBe(before);
 const assets=(await pool.query('SELECT storage_key,sha256,byte_length FROM font_assets')).rows;
 for(const a of assets)expect(await l.files.verify(a.storage_key,a.sha256,Number(a.byte_length))).toBe(true);
});
it('migrates an existing 015 database without changing stored templates, and replays cleanly',async()=>{
 const {readdirSync,mkdtempSync,copyFileSync,readFileSync,rmSync}=await import('node:fs');
 const {registerTemplate,loadTemplate}=await import('../dist/templates/registry.js');
 const old=isolatedDatabase(),dir=mkdtempSync(join(tmpdir(),'fonts-old-migrations-'));
 try{
  await old.setup();for(const n of readdirSync('migrations').filter(n=>/^0(?:0[1-9]|1[0-5])_/.test(n)))copyFileSync(join('migrations',n),join(dir,n));
  unwrap(await migrate(old.pool,dir));const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));
  t.docKey='font-migration-'+randomUUID();t.templateId=t.docKey;unwrap(await registerTemplate(old.pool,JSON.stringify(t)));
  const before=unwrap(await loadTemplate(old.pool,t.docKey,1));
  expect(unwrap(await migrate(old.pool)).applied).toEqual(['016_font_library_staging.sql','017_font_references_jobs.sql','018_font_lifecycle.sql','019_font_height_profiles.sql','020_font_height_proposals.sql','021_section_instances.sql','022_task_intake.sql','023_task_normalization.sql','024_task_processing.sql','025_task_output_format.sql']);
  const legacy=(await old.pool.query('SELECT legacy_bindings FROM font_reference_sets')).rows;expect(legacy.length).toBeGreaterThan(0);expect(legacy.every(r=>r.legacy_bindings.length===4)).toBe(true);
  expect(unwrap(await migrate(old.pool)).applied).toEqual([]);
  expect(unwrap(await loadTemplate(old.pool,t.docKey,1))).toEqual(before);
 }finally{await old.close();rmSync(dir,{recursive:true,force:true});}
});
it('recovers expired and inspected staging files, retaining live sessions and immutable catalog bytes',async()=>{
 const l=await library(),b=await regular();
 const declaration={requestId:randomUUID(),reason:'recovery',files:[{clientKey:'r',byteLength:b.length,sha256:sha(b)}],licenseFiles:[],sourceEvidence:[]};
 const expired=await l.createImport(declaration),live=await l.createImport({...declaration,requestId:randomUUID()});
 for(const i of [expired,live])await l.receive(i.id,'r',(async function*(){yield b;})());
 await pool.query("UPDATE font_imports SET expires_at=now()-interval '1 hour' WHERE id=$1",[expired.id]);
 await expect(l.receive(expired.id,'r',(async function*(){yield b;})())).rejects.toMatchObject({code:'FONT_IMPORT_EXPIRED'});
 const inspected=await intake(l);
 await l.recoverFiles();
 await expect(readFile(l.files.entryPath(expired.id,'r'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(l.files.entryPath(live.id,'r'))).toEqual(b);
 await expect(readFile(l.files.entryPath(inspected.id,'regular'))).rejects.toMatchObject({code:'ENOENT'});
 expect((await l.getImport(inspected.id)).state).toBe('inspected');
});
it('imports every supplied font as preparing with unresolved provider weights, reusing bundled Sarabun bytes',async()=>{
 const folder=process.env.FONT_FIXTURE_DIR,l=await library();
 const bundled=new URL('../node_modules/@flowdoc/core/assets/fonts/',import.meta.url);
 const {fileURLToPath}=await import('node:url');
 const base=folder??fileURLToPath(bundled);
 const collect=async dir=>{const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await collect(p));else if(/\.ttf$/i.test(e.name))out.push(p);}return out;};
 const paths=await collect(base);expect(paths).toHaveLength(folder?29:4);
 const inspect=(await import('../dist/fonts/inspection.js')).inspectFont,groups=new Map();
 for(const path of paths){
  const b=await readFile(path),m=await inspect(path);const {dirname}=await import('node:path');const group=folder?dirname(path):'bundled';
  const g=groups.get(group)??[];g.push({path,b,m});groups.set(group,g);
 }
 let staged=0;
 for(const [group,fonts] of groups){
  const {dirname}=await import('node:path');const licensePath=folder?join(group,'OFL.txt'):join(base,'OFL.txt'),license=await readFile(licensePath);
  // This snapshot records supplied bytes only, not verified upstream METADATA.pb values.
  const metadataHash=sha(Buffer.from(JSON.stringify(fonts.map(f=>({sha256:sha(f.b),family:f.m.names.family})))));
  const declarations=fonts.map((f,i)=>({clientKey:'f'+i,byteLength:f.b.length,sha256:sha(f.b)}));
  const i=await l.createImport({requestId:randomUUID(),reason:'Supplied file trial; upstream weights unverified',files:declarations,licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:sha(license)}],sourceEvidence:declarations.map(d=>({...evidence(d.clientKey,fonts[Number(d.clientKey.slice(1))].b),sourceWeight:null,metadataHash}))});
  for(const [index,f] of fonts.entries())await l.receive(i.id,'f'+index,(async function*(){yield f.b;})());
  await l.receive(i.id,'license',(async function*(){yield license;})());
  const result=await l.inspectImport(i.id,{requestId:randomUUID(),expectedRevision:0,reason:'Inspect supplied fonts'});
  const names=[...new Set(fonts.map(f=>f.m.names.family))];
  const family=await l.createFamily({requestId:randomUUID(),reason:'Supplied family',displayName:names[0],internalNames:names,sourceIdentity:{provider:'google-fonts',providerFamilyKey:'fixture-'+sha(Buffer.from(group)).slice(0,20)}});
  const r=await l.stageRelease({requestId:randomUUID(),reason:'Keep pending weight review',familyId:family.id,version:1,importId:result.id,languageScope:['th','en'],faceBindings:result.files.map(f=>({assetId:f.assetId,sourceEvidenceId:f.sourceEvidenceId,sourceWeight:null,approvedWeight:null,style:f.metadata.style}))});
  expect(r.state).toBe('preparing');expect(r.faces).toHaveLength(fonts.length);expect(r.issues.filter(x=>x.code==='FONT_WEIGHT_REVIEW_REQUIRED')).toHaveLength(fonts.length);staged+=fonts.length;
  for(const f of result.files){expect(f.metadata.coverage).toContain(0x0e01);expect(f.metadata.sha256).toBe(f.sha256);}
 }
 const coreAssets=await Promise.all(['Sarabun-Regular.ttf','Sarabun-Bold.ttf','Sarabun-Italic.ttf','Sarabun-BoldItalic.ttf'].map(n=>readFile(new URL(n,bundled))));
 for(const b of coreAssets){const row=(await pool.query('SELECT count(*)::int n FROM font_assets WHERE sha256=$1',[sha(b)])).rows[0];expect(row.n).toBe(1);}
 console.log(JSON.stringify({fontTrial:{files:staged,families:groups.size,state:'preparing',providerWeights:'unverified',pdfs:0}}));
},120000);
