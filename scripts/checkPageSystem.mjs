// Run after migrate, draft-import and publish of examples/page-system-template.json.
// Uses only the HTTP API; the disposable fixture must never target user data.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
const base=process.env.FLOWDOC_TEST_API_URL;
if(!base)throw Error('Set FLOWDOC_TEST_API_URL to the isolated test API');
const output=process.env.FLOWDOC_TEST_OUTPUT??'artifacts/page-system';
mkdirSync(output,{recursive:true});
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
async function json(path,method='GET',body){
 const res=await fetch(base+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 assert(res.ok,`${method} ${path}: ${res.status} ${await res.clone().text()}`);
 return ok(await res.json());
}
// Compose starts the process before its HTTP listener/worker is ready.
let ready=false;
for(let attempt=0;attempt<60;attempt++){
 try{await json('/health');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}
}
assert(ready,'Isolated API did not become ready');
const contract=await json('/templates/page-system-release/contract?version=1');
assert(contract.sections,'Section contract missing');
writeFileSync(join(output,'contract.json'),JSON.stringify(contract,null,2));
const image=readFileSync('examples/page-system-image.png'),results=[];
for(const name of ['short','long']){
 const upload=await json('/uploads','POST',{requestKey:randomUUID(),items:[{key:'photo',source:'upload',mediaType:'image/png',byteSize:image.length}]});
 const response=await fetch(`${base}/uploads/${upload.uploadId}/items/${upload.items[0].resourceId}/content`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:image});
 assert.equal(response.status,200);ok(await response.json());
 await json(`/uploads/${upload.uploadId}/finalize`,'POST');
 const request=JSON.parse(readFileSync(`examples/page-system-${name}.json`,'utf8').replaceAll('22222222-2222-4222-8222-222222222222',upload.items[0].resourceId));
 request.uploadId=upload.uploadId;
 const accepted=await json('/jobs','POST',request);
 let job;
 const deadline=Date.now()+120000;
 do{
  job=await json('/jobs/'+accepted.jobId);
  if(['succeeded','failed'].includes(job.status))break;
  assert(Date.now()<deadline,'Job timeout');await new Promise(r=>setTimeout(r,150));
 }while(true);
 writeFileSync(join(output,name+'-job.json'),JSON.stringify(job,null,2));
 assert.equal(job.status,'succeeded',JSON.stringify(job));
 // Reuse the accepted layout fixture unchanged: its 2x1 colour swatch
 // intentionally has low DPI, and optional header logos are omitted.
 assert.deepEqual(job.warnings.map(w=>w.code).sort(),[
  ...Array(2).fill('IMAGE_LOW_RESOLUTION'),...Array(7).fill('IMAGE_UNAVAILABLE')
 ].sort(),JSON.stringify(job));
 const pdf=await fetch(`${base}/jobs/${accepted.jobId}/pdf`);
 assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
 const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
 writeFileSync(join(output,`contents-sections-${name}.pdf`),bytes);
 assert.equal((await fetch(`${base}/jobs/${accepted.jobId}/pdf`)).status,410,'Default output consumption');
 results.push({name,jobId:accepted.jobId,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,expectedWarnings:job.warnings});
}
const result={status:'PASS',serviceVersion:JSON.parse(readFileSync('package.json')).version,core:JSON.parse(readFileSync('vendor/manifest.json')),results};
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
