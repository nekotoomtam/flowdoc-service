import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {renderPinnedJob} from '../dist/jobs/render.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const result=[];
for(const [name,templateFile,requestFile] of [['legacy-area','area-document-template.json','area-document-request.json'],['legacy-pages','page-numbering-template.json','page-numbering-request.json']]){
 const template=JSON.parse(await readFile('examples/'+templateFile,'utf8')),request=JSON.parse(await readFile('examples/'+requestFile,'utf8'));
 const valid=validateTemplate(template);assert(valid.ok,JSON.stringify(valid));const prepared=prepareGeneration(valid.value,request);assert(prepared.ok,JSON.stringify(prepared));
 const pdf=await renderPinnedJob(prepared.value,valid.value.definition);assert(pdf.ok,JSON.stringify(pdf));await writeFile('/evidence/'+name+'.pdf',pdf.value.bytes);
 result.push({name,sha256:createHash('sha256').update(pdf.value.bytes).digest('hex'),fingerprint:valid.value.fingerprint,bytes:pdf.value.bytes.length});
}
await writeFile('/evidence/legacy-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:'PASS',result}));
