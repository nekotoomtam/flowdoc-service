import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),id=Date.now().toString(),project='flowdoc-area-'+id,output=join(root,'artifacts',id);
mkdirSync(output,{recursive:true});const envFile=join(output,'compose.env');
writeFileSync(envFile,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=flowdoc-cell-runtime:${id}\nFLOWDOC_VERIFY_IMAGE=flowdoc-cell-tests:${id}\n`,{mode:0o600});
const prefix=['compose','--env-file',envFile,'-p',project];
const checks=['area-assembly','area-version','area-api','area-render','cell-repeat-assembly','cell-repeat-api','assembly','current','version-render','cell-content-api','image-api','merged-table-api','contents-api','version-boundary','upload-contract','processor','render','link-api'].map(n=>'tests/'+n+'.test.mjs');
function run(args,label){try{const text=execFileSync('docker',[...prefix,...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024});writeFileSync(join(output,label+'.log'),text);return text;}catch(e){writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Check failed: '+label);}}
let result;
try{
 run(['build','verification'],'build');run(['up','-d','--wait','db'],'db');
 const migration=JSON.parse(run(['run','--rm','-T','--entrypoint','node','verification','dist/cli.js','migrate'],'migrate'));if(!migration.ok)throw Error('Migration failed');
 const tests=JSON.parse(run(['run','--rm','-T','verification',...checks,'--reporter=json'],'tests'));
 if(!tests.success||tests.numPendingTests)throw Error('Tests failed or skipped');
 result={status:'PASS',output,project,core:JSON.parse(readFileSync(join(root,'vendor/manifest.json'),'utf8')),checks,tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,skipped:tests.numPendingTests}};
}catch(e){result={status:'FAIL',output,project,message:e.message};process.exitCode=1;}
finally{try{run(['down','--volumes','--remove-orphans'],'cleanup');}catch(e){result={...result,cleanup:e.message};process.exitCode=1;}}
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
