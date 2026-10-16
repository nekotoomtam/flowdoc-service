import {inspectFont} from '../dist/fonts/inspection.js';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFontLibrary} from '../dist/fonts/service.js';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
export async function stageFont(pool,root,file='Sarabun-Regular.ttf',weight=400){
 const source=isAbsolute(file)?file:fileURLToPath(new URL('../node_modules/@flowdoc/core/assets/fonts/'+file,import.meta.url));
 const metadata=await inspectFont(source);
 const lib=await createFontLibrary({pool,root,principal:'font-test-admin'}),font=await readFile(source),license=await readFile(join(dirname(source),'OFL.txt')),sha=b=>createHash('sha256').update(b).digest('hex');
 const family=await lib.createFamily({requestId:randomUUID(),reason:'Test fixture',displayName:'Test Sarabun',internalNames:[metadata.names.family],sourceIdentity:{provider:'google-fonts',providerFamilyKey:randomUUID()}});
 const i=await lib.createImport({requestId:randomUUID(),reason:'Test fixture',files:[{clientKey:'font',byteLength:font.length,sha256:sha(font)}],licenseFiles:[{clientKey:'license',byteLength:license.length,sha256:sha(license)}],sourceEvidence:[{clientKey:'font',provider:'google-fonts',locator:'https://fonts.google.com/specimen/'+encodeURIComponent(metadata.names.family),retrievedAt:'2026-10-16T00:00:00.000Z',metadataHash:'a'.repeat(64),fileHashBinding:sha(font),sourceWeight:weight,licenseClientKeys:['license']}]});
 for(const [key,b] of [['font',font],['license',license]])await lib.receive(i.id,key,(async function*(){yield b;})());
 const inspected=await lib.inspectImport(i.id,{requestId:randomUUID(),reason:'Test fixture',expectedRevision:0}),f=inspected.files[0];
 const release=await lib.stageRelease({requestId:randomUUID(),reason:'Test fixture',familyId:family.id,version:1,importId:i.id,languageScope:['th','en'],faceBindings:[{assetId:f.assetId,sourceEvidenceId:f.sourceEvidenceId,sourceWeight:weight,approvedWeight:weight,style:'normal'}]});
 return {...release,font,sha256:sha(font),fontSelection:{kind:'library',releaseId:release.id,weight,style:'normal'}};
}
