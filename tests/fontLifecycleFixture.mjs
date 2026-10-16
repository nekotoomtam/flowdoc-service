import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createFontLibrary} from '../dist/fonts/service.js';
import {createFontLifecycle} from '../dist/fonts/lifecycle.js';
import {inspectFont} from '../dist/fonts/inspection.js';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
export const mutation=(expectedRevision,extra={})=>({requestId:randomUUID(),reason:'Isolated lifecycle verification',expectedRevision,...extra});
export async function stageSet(pool,root,{files=['Sarabun-Regular.ttf'],weights=[400],familyId,version=1}={}){
 const lib=await createFontLibrary({pool,root,principal:'font-test-admin'}),sha=b=>createHash('sha256').update(b).digest('hex');
 const sources=files.map(f=>f.startsWith('/')?f:fileURLToPath(new URL('../node_modules/@flowdoc/core/assets/fonts/'+f,import.meta.url))),fonts=await Promise.all(sources.map(f=>readFile(f))),metadata=await Promise.all(sources.map(f=>inspectFont(f))),license=await readFile(join(dirname(sources[0]),'OFL.txt'));
 if(!familyId)familyId=(await lib.createFamily({requestId:randomUUID(),reason:'Fixture',displayName:'Review family',internalNames:[...new Set(metadata.map(m=>m.names.family))],sourceIdentity:{provider:'google-fonts',providerFamilyKey:randomUUID()}})).id;
 const declared=fonts.map((b,i)=>({clientKey:'f'+i,byteLength:b.length,sha256:sha(b)})),i=await lib.createImport({requestId:randomUUID(),reason:'Fixture',files:declared,licenseFiles:[{clientKey:'license',sha256:sha(license),byteLength:license.length}],sourceEvidence:declared.map((f,i)=>({clientKey:f.clientKey,provider:'google-fonts',locator:'https://fonts.google.com/specimen/Sarabun',retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'b'.repeat(64),fileHashBinding:f.sha256,sourceWeight:weights[i],licenseClientKeys:['license']}))});
 for(const [index,b] of fonts.entries())await lib.receive(i.id,'f'+index,(async function*(){yield b;})());await lib.receive(i.id,'license',(async function*(){yield license;})());
 const inspected=await lib.inspectImport(i.id,mutation(0));const candidate={requestId:randomUUID(),reason:'Fixture',familyId,version,importId:i.id,languageScope:['th','en'],faceBindings:inspected.files.map(f=>{const index=Number(f.clientKey.slice(1));return {assetId:f.assetId,sourceEvidenceId:f.sourceEvidenceId,sourceWeight:weights[index],approvedWeight:weights[index],style:metadata[index].style};})};
 return {...await lib.stageRelease(candidate),candidate};
}
export async function releaseSet(pool,root,f){const life=createFontLifecycle({pool,root,principal:'font-test-admin'}),submitted=await life.submitReview(f.id,mutation(f.revision,{manifestDigest:f.manifestDigest})),run=await life.run(submitted.reviewId,mutation(submitted.revision,{manifestDigest:submitted.manifestDigest}));if(!run.report.ok)throw Error(JSON.stringify(run));const approved=await life.approve(submitted.reviewId,mutation(run.revision,{manifestDigest:run.report.manifestDigest,reportDigest:run.reportDigest,artifactHashes:run.report.faces.map(f=>f.artifactHash)}));const activated=await life.activate(f.id,mutation(approved.revision,{reviewId:submitted.reviewId,manifestDigest:f.manifestDigest}));return {...f,...activated,reviewId:submitted.reviewId,run};}
