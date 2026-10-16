import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),id=Date.now().toString(),project='flowdoc-font-lifecycle-'+id,output=join(root,'artifacts',id);
mkdirSync(output,{recursive:true});
const envFile=join(output,'compose.env'),runtimeTag='flowdoc-font-runtime:'+id,verifyTag='flowdoc-font-tests:'+id;
writeFileSync(envFile,'FLOWDOC_DB_PASSWORD='+randomBytes(24).toString('hex')+'\nFLOWDOC_REGISTRY_IMAGE='+runtimeTag+'\nFLOWDOC_VERIFY_IMAGE='+verifyTag+'\n',{mode:0o600});
const prefix=['compose','--env-file',envFile,'-p',project];
function docker(args,label){
 try{const out=execFileSync('docker',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});if(label)writeFileSync(join(output,label+'.log'),out);return out;}
 catch(e){if(label){writeFileSync(join(output,label+'.log'),String(e.stdout??''));writeFileSync(join(output,label+'.stderr.log'),String(e.stderr??''));}throw Error('Font check failed: '+label);}
}
const compose=(args,label)=>docker([...prefix,...args],label);
try{
 compose(['build','registry','verification'],'build');
 const runtimeImage=docker(['image','inspect',runtimeTag,'--format','{{.Id}}']).trim(),verificationImage=docker(['image','inspect',verifyTag,'--format','{{.Id}}']).trim();
 compose(['up','-d','--wait','db'],'database');
 assert.equal(JSON.parse(compose(['run','--rm','-T','registry','migrate'],'migration')).ok,true);
 const fixtures=process.env.FONT_FIXTURE_DIR?['-v',resolve(process.env.FONT_FIXTURE_DIR)+':/fixtures/fonts:ro','-e','FONT_FIXTURE_DIR=/fixtures/fonts']:[];
 const tests=JSON.parse(compose(['run','--rm','-T',...fixtures,'-v',output+':/evidence','-e','FONT_PROOF_DIR=/evidence','verification',...(process.env.FONT_TEST_FILES??'').split(',').filter(Boolean),'--reporter=json'],'tests'));
 writeFileSync(join(output,'tests-summary.json'),JSON.stringify({success:tests.success,passed:tests.numPassedTests,failed:tests.numFailedTests,pending:tests.numPendingTests},null,2));
 assert.equal(tests.success,true);assert.equal(tests.numPendingTests,0);
 const persist=mode=>JSON.parse(compose(['run','--rm','-T','-v',project+'_font-files:/app/staging','-v',join(root,'tests','checkFontPersisted.mjs')+':/app/tests/checkFontPersisted.mjs:ro','--entrypoint','node','registry','tests/checkFontPersisted.mjs',mode],'persistence-'+mode));
 assert.equal(persist('write').status,'PASS');
 const jobPersist=mode=>JSON.parse(compose(['run','--rm','-T',...fixtures,'-v',project+'_font-files:/app/staging','-v',join(root,'tests')+':/app/tests:ro','-v',output+':/evidence','--entrypoint','node','registry','tests/checkFontLifecyclePersisted.mjs',mode],'job-persistence-'+mode));
 assert.equal(jobPersist('write').status,'PASS');
 compose(['restart','db'],'restart');compose(['up','-d','--wait','db'],'database-after');
 assert.deepEqual(JSON.parse(compose(['run','--rm','-T','registry','migrate'],'migration-replay')).value.applied,[]);
 assert.equal(persist('read').status,'PASS');
 assert.equal(jobPersist('read').status,'PASS');
 compose(['run','--rm','-T','-v',join(root,'tests')+':/app/tests:ro','-v',output+':/evidence','--entrypoint','node','registry','tests/checkLegacyFonts.mjs'],'legacy');
 assert.equal(docker(['image','inspect',runtimeTag,'--format','{{.Id}}']).trim(),runtimeImage);
 compose(['stop'],'stop');
 const result={status:'PASS',project,output,runtimeImage,verificationImage,tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,pending:tests.numPendingTests},suppliedDataset:!!process.env.FONT_FIXTURE_DIR,testSelection:process.env.FONT_TEST_FILES||'full suite',checks:[process.env.FONT_TEST_FILES?'selected Service tests on isolated fresh PostgreSQL':'full Service suite on isolated fresh PostgreSQL','populated 015 migration and unchanged template','draft readiness, retained references and pinned job fonts','concurrent/idempotent dedup and rollback recovery','same runtime image and files after DB restart','queued preview font snapshot and lineage survive DB restart and retirement','real worker PDF after restart','legacy rendering fixtures','administrator lifecycle and authoring-token isolation','default clear and retired-document generation after DB restart','no deployment or live data'],resources:'containers stopped; named database/font volumes retained; no published ports'};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}catch(e){const result={status:'FAIL',project,output,message:e.message};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.error(JSON.stringify(result));process.exitCode=1;}finally{compose(['stop'],'stop-final');}
