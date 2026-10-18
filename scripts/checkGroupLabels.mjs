// Repository-owned isolated native integration runner; never uses the installed API/database.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,cpSync,unlinkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';import {homedir} from 'node:os';import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),pc=resolve(process.env.FLOWDOCMAKE_PROJECT_ROOT??'../flowdoc-project-control'),id=String(Date.now());
const project='flowdoc-font-tools-'+id,output=join(root,'artifacts',id),runtime='flowdoc-group-label-runtime:'+id,verification='flowdoc-group-label-tests:'+id;
mkdirSync(output,{recursive:true});const author=randomBytes(24).toString('hex'),admin=randomBytes(24).toString('hex'),env=join(output,'compose.env'),credential=join(output,'authoring.env');
writeFileSync(env,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=${runtime}\nFLOWDOC_VERIFY_IMAGE=${verification}\nFLOWDOC_API_PORT=0\nLABEL_AUTHOR=${author}\nLABEL_ADMIN=${admin}\n`,{mode:0o600});
const override=join(output,'tools.yaml');writeFileSync(override,'services:\n  api:\n    environment:\n      AUTHORING_TOKEN: ${LABEL_AUTHOR}\n      AUTHORING_PRINCIPAL: group-label-owner\n      FONT_ADMIN_TOKEN: ${LABEL_ADMIN}\n      FONT_ADMIN_PRINCIPAL: group-label-admin\nnetworks:\n  private:\n    ipam:\n      config: [{subnet: 10.253.64.0/24}]\n  image-egress:\n    ipam:\n      config: [{subnet: 10.253.65.0/24}]\n');
const prefix=['compose','--env-file',env,'-p',project,'-f',join(root,'compose.yaml'),'-f',override];
const run=(cmd,args,label,options={})=>{try{const out=execFileSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe'],...options});if(label)writeFileSync(join(output,label+'.log'),out);return out;}catch(e){if(label)writeFileSync(join(output,label+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Group-label check failed: '+label);}};
const docker=(args,label)=>run('docker',args,label),compose=(args,label)=>docker([...prefix,...args],label);
try{
 compose(['build','registry','verification'],'build');compose(['up','-d','--wait','db'],'database');assert(JSON.parse(compose(['run','--rm','-T','registry','migrate'],'migration')).ok);
 compose(['up','-d','api'],'api');const url='http://'+compose(['port','api','3000']).trim();
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(url+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,'API readiness');
 const plugin=join(output,'candidate-plugin');cpSync(join(pc,'plugins/flowdocmake'),plugin,{recursive:true});
 writeFileSync(credential,'AUTHORING_TOKEN='+author+'\n',{mode:0o600});
 const local=JSON.parse(readFileSync(join(homedir(),'.codex/flowdocmake.local.json'))),config=join(output,'flowdocmake-test.json');
 writeFileSync(config,JSON.stringify({pluginRoot:plugin,serviceRoot:root,credentialFile:credential,url,container:project+'-api-1',python:local.python,previewDirectory:join(output,'previews')}));
 const childEnv={...process.env,FLOWDOCMAKE_CONFIG:config,FLOWDOCMAKE_SERVICE_ROOT:root,FONT_TEST_CONTAINER:project+'-api-1',GROUP_LABEL_PROOF_DIR:join(output,'mcp'),GROUP_LABEL_SERVICE_ROOT:root};
 const fsPluginTests=['flowdocmake.test.mjs','flowdocmake-group-label.test.mjs','flowdocmake-workflow.test.mjs','flowdocmake-section-instances.test.mjs','flowdocmake-preflight.test.mjs','flowdocmake-integration.test.mjs','flowdocmake-snapshot.test.mjs','flowdocmake-font-height.test.mjs'].map(p=>join(pc,'tests',p));
 const node=(file,args,label)=>run(process.execPath,[join(pc,file),...args],label,{cwd:pc,env:childEnv});
 node('tests/checkFlowdocmakeGroupLabels.mjs',[],'mcp-group-labels');
 run(process.execPath,['--test','--test-concurrency=1',...fsPluginTests], 'plugin-tests',{cwd:pc,env:childEnv});
 compose(['stop','api'],'stop-api');
 const selected=process.argv.slice(2);
 const tests=JSON.parse(compose(['run','--rm','-T','-e','GROUP_LABEL_PROOF_DIR=/proof','-v',join(output,'api')+':/proof','verification',...selected,'--reporter=json'],'tests'));
 const summary=summarizeTests(tests);
 writeFileSync(join(output,'result.json'),JSON.stringify({status:summary.skipped.length?'PASS_WITH_EXPLICIT_SKIPS':'PASS',project,output,core:JSON.parse(readFileSync(join(root,'vendor/manifest.json'))),tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,skipped:tests.numPendingTests},unverified:summary.skipped,selectedTests:selected,plugin:'actual isolated stdio/API/native child'},null,2));console.log(output);
}catch(e){writeFileSync(join(output,'failure.json'),JSON.stringify({status:'FAIL',project,message:e.message}));console.error(e.message);process.exitCode=1;}
finally{
 compose(['down','--volumes','--remove-orphans'],'cleanup');for(const tag of [runtime,verification])try{docker(['image','rm',tag]);}catch{}
 for(const path of [env,credential])try{unlinkSync(path);}catch{}
}
function summarizeTests(tests){
 assert(tests.success);assert.equal(tests.numFailedTests,0);
 const skipped=tests.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='skipped').map(a=>({file:t.name.split('/').at(-1),title:a.title,reason:'External font files or a separately prepared height-delivery fixture required; not verified by this run.'})));
 // External height-delivery proofs are separate from Stage 3 group-label acceptance.
 const externalFiles=new Set(['fonts-height-delivery-guard.test.mjs','fonts-height-proposals.test.mjs','fonts-height-supplied.test.mjs']);
 assert(skipped.every(a=>externalFiles.has(a.file)),'Unexpected skipped acceptance test');
 assert.equal(skipped.length,tests.numPendingTests);
 for(const t of tests.testResults.filter(t=>/group-label-(api|unit)[.]test[.]mjs$/.test(t.name)))assert(t.assertionResults.every(a=>a.status==='passed'),'Group-label acceptance must not skip');
 return {skipped};
}
