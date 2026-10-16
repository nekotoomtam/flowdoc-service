import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,cpSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {join,resolve} from 'node:path';import {homedir} from 'node:os';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),id=String(Date.now()),project='flowdoc-font-tools-'+id,output=join(root,'artifacts',id),pc=resolve(process.env.FLOWDOCMAKE_PROJECT_ROOT??'../flowdoc-project-control');mkdirSync(output,{recursive:true});
const runtime='flowdoc-font-runtime:'+id,verification='flowdoc-font-tests:'+id,author=randomBytes(24).toString('hex'),admin=randomBytes(24).toString('hex');
const env=join(output,'compose.env');writeFileSync(env,'FLOWDOC_DB_PASSWORD='+randomBytes(24).toString('hex')+'\nFLOWDOC_REGISTRY_IMAGE='+runtime+'\nFLOWDOC_VERIFY_IMAGE='+verification+'\nFLOWDOC_API_PORT=0\nFONT_TEST_AUTHORING_TOKEN='+author+'\nFONT_TEST_ADMIN_TOKEN='+admin+'\n',{mode:0o600});
const override=join(output,'tools.yaml');writeFileSync(override,'services:\n  api:\n    environment:\n      AUTHORING_TOKEN: ${FONT_TEST_AUTHORING_TOKEN}\n      AUTHORING_PRINCIPAL: font-tools-owner\n      FONT_ADMIN_TOKEN: ${FONT_TEST_ADMIN_TOKEN}\n      FONT_ADMIN_PRINCIPAL: font-test-admin\n      FONT_STORAGE_DIR: /app/staging/fonts\n');
const prefix=['compose','--env-file',env,'-p',project,'-f',join(root,'compose.yaml'),'-f',override];
function docker(args,label){try{const s=execFileSync('docker',args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']});if(label)writeFileSync(join(output,label+'.log'),s);return s;}catch(e){if(label)writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Font tools check failed: '+label);}}
const compose=(a,l)=>docker([...prefix,...a],l);
try{
 compose(['build','registry','verification'],'build');compose(['up','-d','--wait','db'],'database');assert(JSON.parse(compose(['run','--rm','-T','registry','migrate'],'migration')).ok);
 compose(['up','-d','api'],'api');const mapped=compose(['port','api','3000']).trim(),url='http://'+mapped;
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,'API readiness');
 const testPackage=join(output,'installed-flowdocmake');cpSync(join(pc,'plugins/flowdocmake'),testPackage,{recursive:true});
 const old=JSON.parse(readFileSync(join(homedir(),'.codex/flowdocmake.local.json'),'utf8')),credential=join(output,'authoring.env');writeFileSync(credential,'AUTHORING_TOKEN='+author+'\n',{mode:0o600});
 const config=join(output,'flowdocmake-test.json');writeFileSync(config,JSON.stringify({pluginRoot:testPackage,serviceRoot:root,credentialFile:credential,url,container:project+'-api-1',python:old.python,previewDirectory:join(output,'previews')}));
 const childEnv={...process.env,FLOWDOCMAKE_CONFIG:config,FONT_ADMIN_TOKEN:admin,FONT_ADMIN_BASE_URL:url,FONT_TEST_AUTHORING_TOKEN:author,FONT_TEST_CONTAINER:project+'-api-1',FONT_PROOF_DIR:output,FLOWDOCMAKE_SERVICE_ROOT:root};
 const run=(path,args,label)=>{try{const s=execFileSync(process.execPath,[join(pc,path),...args],{cwd:pc,env:childEnv,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});writeFileSync(join(output,label+'.log'),s);return s;}catch(e){writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Font tools check failed: '+label);}};
 run('tools/check-flowdocmake.mjs',[testPackage],'preflight');run('tests/checkFlowdocmakeFonts.mjs',[],'flowdocmake-fonts');
 run('tests/runFlowdocmakeChecks.mjs',[],'flowdocmake-regressions');
 // Processor coordination is database-wide, even when test schemas are isolated.
 compose(['stop','api'],'stop-api-before-suite');
 const tests=JSON.parse(compose(['run','--rm','-T','verification','--reporter=json'],'tests'));assert(tests.success);assert.equal(tests.numPendingTests,0);
 compose(['run','--rm','-T','-v',join(root,'tests')+':/app/tests:ro','-v',output+':/evidence','--entrypoint','node','registry','tests/checkLegacyFonts.mjs'],'legacy');
 const image=docker(['image','inspect',runtime,'--format','{{.Id}}']).trim();const result={status:'PASS',project,output,service:'0.4.0',core:'0.4.0',runtimeImage:image,plugin:'0.2.1',tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,pending:tests.numPendingTests},checks:['real CLI admin import/review/release and authorization','installed candidate FlowDocMake exact preflight and guide hashes','active catalog/default/real faces','MCP blocked draft repair/stale revision/actual glyph diagnostics','retired source and server clone rights; forged JSON blocked','real worker PDFs via MCP; legacy fixtures','existing FlowDocMake regressions','full isolated PostgreSQL suite'],resources:'own test containers/networks removed; named volumes retained; user runtime/configuration unchanged'};writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(e){writeFileSync(join(output,'result.json'),JSON.stringify({status:'FAIL',project,output,message:e.message}));console.error(JSON.stringify({status:'FAIL',project,output,message:e.message}));process.exitCode=1;}finally{compose(['down','--remove-orphans'],'cleanup');}
