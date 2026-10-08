import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const id=Date.now(),project='flowdoc-r4-api-'+id,output=join('artifacts',String(id));mkdirSync(output,{recursive:true});
const envFile=join(output,'compose.env'),runtime='flowdoc-service:r4-'+id,verification='flowdoc-service-tests:r4-'+id;
writeFileSync(envFile,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=${runtime}\nFLOWDOC_VERIFY_IMAGE=${verification}\nFLOWDOC_API_PORT=0\n`);
const prefix=['compose','--env-file',envFile,'-p',project];
const docker=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
function compose(args,label){try{const value=docker([...prefix,...args]);if(label)writeFileSync(join(output,label+'.log'),value);return value;}catch(e){writeFileSync(join(output,(label??'error')+'.log'),String(e.stdout??'')+'\n'+String(e.stderr??''));throw Error('Container step failed: '+label);}}
// Fetch inside the network, avoiding host/WSL networking differences.
function request(path,body){const source=`const r=await fetch('http://api:3000${path}',${body===undefined?'{}':JSON.stringify({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const b=Buffer.from(await r.arrayBuffer());console.log(JSON.stringify({status:r.status,type:r.headers.get('content-type'),body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(b.toString()):b.toString('base64')}));`;return JSON.parse(compose(['exec','-T','api','node','--input-type=module','-e',source]));}
async function ready(){for(let n=0;n<60;n++){try{if(request('/health').status===200)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw Error('API not ready');}
async function done(job){for(let n=0;n<100;n++){const r=request('/jobs/'+job);if(['succeeded','failed'].includes(r.body.value.status))return r.body.value;await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');}
try{
 compose(['build','registry','verification'],'build');compose(['up','-d','--wait','db'],'db');
 assert.equal(JSON.parse(compose(['run','--rm','-T','registry','migrate'],'migrate')).ok,true);
 assert.equal(JSON.parse(compose(['run','--rm','-T','registry','register','examples/srs-template.json'],'register')).ok,true);
 compose(['up','-d','api'],'api');await ready();
 const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));assert.equal(request('/templates/'+input.docKey+'/contract?version=1').status,200);
 const jobs=[];for(let n=0;n<3;n++){const r=request('/jobs',{...input,data:{projectName:'API '+n}});assert.equal(r.status,202);jobs.push(r.body.value.jobId);}
 const hashes=[];for(const job of jobs){assert.equal((await done(job)).status,'succeeded');const r=request('/jobs/'+job+'/pdf');assert.equal(r.status,200);const bytes=Buffer.from(r.body,'base64');assert.equal(bytes.subarray(0,5).toString(),'%PDF-');writeFileSync(join(output,job+'.pdf'),bytes);hashes.push(createHash('sha256').update(bytes).digest('hex'));assert.equal(request('/jobs/'+job+'/pdf').status,410);}
 assert.equal(new Set(hashes).size,3);
 compose(['stop','api'],'stop-api');
 const fixtures=JSON.parse(compose(['run','--rm','-T','-v',project+'_outputs:/app/output','--entrypoint','node','verification','tests/api-restart.mjs'],'fixtures'));
 compose(['up','-d','api'],'restart-api');await ready();assert.equal((await done(fixtures.queued)).status,'succeeded');assert.equal((await done(fixtures.running)).errors[0].code,'PROCESS_INTERRUPTED');
 assert.equal(request('/jobs/'+fixtures.succeeded).body.value.hasWarnings,true);assert.deepEqual(request('/jobs/'+fixtures.succeeded).body.value.skippedContentIndices,[input.content.length]);
 assert.equal(compose(['exec','-T','api','node','-e',`console.log(require('fs').existsSync('/app/output/${fixtures.running}.pdf'))`]).trim(),'false');
 for(let n=0;n<2;n++)assert.equal(request('/jobs/'+fixtures.succeeded+'/pdf').status,200);
 assert.equal(request('/jobs/'+jobs[0]+'/pdf').status,410);
 const report={status:'PASS',project,output,serviceVersion:JSON.parse(readFileSync('package.json')).version,runtimeImage:docker(['image','inspect',runtime,'--format','{{.Id}}']).trim(),jobs,hashes,fixtures,checks:['real API three distinct PDFs','default consumed outputs return 410','restart queued/running/succeeded','retained repeat download','consumed output stays unavailable after restart']};
 writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){writeFileSync(join(output,'failure.json'),JSON.stringify({status:'FAIL',message:e.message,project}));console.error(e.message);process.exitCode=1;}finally{compose(['stop'],'stop');}
