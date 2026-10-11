// Isolated DB/API proof for the model-17 consumer; no host DB or published ports.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const id=Date.now(),project='flowdoc-row-groups-'+id,output=join('artifacts',String(id));mkdirSync(output,{recursive:true});
const runtime='flowdoc-row-groups-runtime:'+id,verification='flowdoc-row-groups-tests:'+id,env=join(output,'compose.env');
writeFileSync(env,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=${runtime}\nFLOWDOC_VERIFY_IMAGE=${verification}\n`,{mode:0o600});
const prefix=['compose','--env-file',env,'-p',project];
const run=(args,label)=>{try{const out=execFileSync('docker',[...prefix,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});writeFileSync(join(output,label+'.log'),out);return out;}catch(e){writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Check failed: '+label);}};
let passed=false;
try{
 run(['build','registry','verification'],'build');run(['up','-d','--wait','db'],'database');
 const tests=JSON.parse(run(['run','--rm','-T','verification',...process.argv.slice(2),'--reporter=json'],'tests'));
 assert.equal(tests.success,true);assert.equal(tests.numPendingTests,0);
 const result={status:'PASS',project,output,version:JSON.parse(readFileSync('package.json')).version,core:JSON.parse(readFileSync('vendor/manifest.json')),tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,skipped:tests.numPendingTests},selectedTests:process.argv.slice(2),checks:process.argv.length>2?['selected tests on isolated PostgreSQL']:['isolated PostgreSQL','populated012 upgrade and replay','snapshot parent remap','nested image/link jobs through HTTP handlers and real worker/PDF runtime','legacy affected suite']};
 writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));passed=true;console.log(JSON.stringify(result));
}catch(e){writeFileSync(join(output,'failure.json'),JSON.stringify({status:'FAIL',project,message:e.message}));console.error(e.message);process.exitCode=1;}
finally{run(['down','--volumes','--remove-orphans'],'cleanup');for(const tag of [runtime,verification])try{execFileSync('docker',['image','rm',tag],{stdio:'pipe'});}catch{}unlinkSync(env);if(!passed)console.error('Inspect '+output);}
