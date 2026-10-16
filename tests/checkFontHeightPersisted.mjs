// Manual isolated-container check: seed, restart the test DB, then verify.
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {migrate} from '../dist/db/migrate.js';
import {createFontHeightProfiles} from '../dist/fonts/heightProfiles.js';
import {stageSet,mutation as m} from './fontLifecycleFixture.mjs';
const [mode,file]=process.argv.slice(2);
if(!['seed','verify'].includes(mode)||!file||!process.env.DATABASE_URL)throw Error('Isolated verification arguments required');
const admin=new Pool({connectionString:process.env.DATABASE_URL});
let pool;
try{
 const state=mode==='seed'?{schema:'height_restart_'+randomUUID().replaceAll('-',''),root:'/evidence/font-store'}:JSON.parse(await readFile(file,'utf8'));
 if(!/^height_restart_[0-9a-f]{32}$/.test(state.schema))throw Error('Invalid isolated schema');
 if(mode==='seed'){await admin.query('CREATE SCHEMA '+state.schema);await mkdir(state.root,{recursive:true});}
 pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+state.schema});
 const profiles=createFontHeightProfiles({pool,root:state.root,principal:'font-test-admin'});
 if(mode==='seed'){
  assert.equal((await migrate(pool)).ok,true);
  const release=await stageSet(pool,state.root),profile=await profiles.measure(release.id,m(release.revision,{manifestDigest:release.manifestDigest}));
  await profiles.approve(profile.id,m(release.revision,{profileDigest:profile.profileDigest}));
  const assignment=await profiles.assign(release.id,m(0,{profileId:profile.id,profileDigest:profile.profileDigest}));
  Object.assign(state,{releaseId:release.id,profile:await profiles.get(profile.id),assignment,release:(await pool.query('SELECT * FROM font_releases WHERE id=$1',[release.id])).rows[0],assets:(await pool.query('SELECT id,sha256,parsed_metadata FROM font_assets ORDER BY id')).rows});
  await writeFile(file,JSON.stringify(state,null,2));
 }else{
  assert.deepEqual(await profiles.get(state.profile.id),state.profile);
  const persisted=(await pool.query('SELECT revision,profile_id,profile_digest FROM font_height_profile_assignments WHERE release_id=$1',[state.releaseId])).rows[0];
  assert.equal(persisted.profile_id,state.assignment.profileId);assert.equal(persisted.profile_digest,state.assignment.profileDigest);assert.equal(persisted.revision,1);
  assert.deepEqual((await pool.query('SELECT id,sha256,parsed_metadata FROM font_assets ORDER BY id')).rows,state.assets);
  assert.equal((await pool.query('SELECT manifest_digest FROM font_releases WHERE id=$1',[state.releaseId])).rows[0].manifest_digest,state.release.manifest_digest);
  await pool.end();pool=null;await admin.query('DROP SCHEMA '+state.schema+' CASCADE');
 }
 console.log(JSON.stringify({fontHeightPersistence:mode,status:'PASS'}));
}finally{if(pool)await pool.end();await admin.end();}
