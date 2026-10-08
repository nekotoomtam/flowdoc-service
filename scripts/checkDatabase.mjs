import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),id=Date.now().toString(),project='flowdoc-r3-'+id,output=join(root,'artifacts',id);mkdirSync(output,{recursive:true});
const runtimeTag='flowdoc-service:r3-'+id,verifyTag='flowdoc-service-tests:r3-'+id,envFile=join(output,'compose.env');
writeFileSync(envFile,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=${runtimeTag}\nFLOWDOC_VERIFY_IMAGE=${verifyTag}\n`,{mode:0o600});
const prefix=['compose','--env-file',envFile,'-p',project];
function docker(args){return execFileSync('docker',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});}
function compose(args,label){try{const text=docker([...prefix,...args]);if(label)writeFileSync(join(output,label+'.log'),text);return text;}catch(e){if(label)writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error(`Docker check failed: ${label??args[0]}; inspect local artifact logs`);}}
const cli=(args,label)=>JSON.parse(compose(['run','--rm','-T','registry',...args],label));
try{
 compose(['build','registry','verification'],'build');
 const runtimeImage=docker(['image','inspect',runtimeTag,'--format','{{.Id}}']).trim(),verificationImage=docker(['image','inspect',verifyTag,'--format','{{.Id}}']).trim();
 compose(['up','-d','--wait','db'],'database-start');
 const migration=cli(['migrate'],'migrate');assert.equal(migration.ok,true);assert.deepEqual(migration.value.applied,['001_initial.sql','002_current_version.sql','003_output_lifetime.sql','004_upload_staging.sql']);
 const testText=compose(['run','--rm','-T','verification','--reporter=json'],'tests');const tests=JSON.parse(testText);assert.equal(tests.success,true);assert.equal(tests.numPendingTests,0);
 const registration=cli(['register','examples/srs-template.json'],'register');assert.equal(registration.ok,true);assert.equal(registration.value.created,true);
 const cliCurrent=JSON.parse(compose(['run','--rm','-T','--entrypoint','node','verification','tests/checkCurrentCli.mjs'],'current-cli'));assert.equal(cliCurrent.status,'PASS');
 const before=cli(['show','srs-table-trial','1'],'show-before');assert.equal(before.ok,true);
 compose(['restart','db'],'restart');compose(['up','-d','--wait','db'],'database-ready');
 const replay=cli(['migrate'],'migrate-after');assert.equal(replay.ok,true);assert.deepEqual(replay.value.applied,[]);
 const after=cli(['show','srs-table-trial','1'],'show-after');assert.deepEqual(after,before);
 const persisted=JSON.parse(compose(['run','--rm','-T','--entrypoint','node','verification','tests/checkPersisted.mjs'],'persisted'));assert.equal(persisted.status,'PASS');
 assert.equal(docker(['image','inspect',runtimeTag,'--format','{{.Id}}']).trim(),runtimeImage);
 const postgresVersion=compose(['exec','-T','db','psql','-U','flowdoc','-d','flowdoc','-Atc','SELECT version();'],'postgres-version').trim();
 compose(['stop'],'stop');
 const report={status:'PASS',serviceVersion:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,project,output,runtimeImage,verificationImage,postgresVersion,core:JSON.parse(readFileSync(join(root,'vendor/manifest.json'),'utf8')),tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,skipped:tests.numPendingTests},registration,cliCurrent,persisted,checks:['fresh isolated PostgreSQL volume','transactional migration/replay','real SQL constraints/concurrency tests','raw registration CLI','exact/latest load','restart persistence','same runtime image before/after'],resources:'containers stopped; project network and DB volume retained; no published ports or source mounts'};
 writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({status:'FAIL',project,output,message:error.message},null,2));console.error(JSON.stringify({status:'FAIL',project,output,message:error.message}));process.exitCode=1;}
