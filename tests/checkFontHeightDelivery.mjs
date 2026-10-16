import {calculateFontHeightAdjustment} from '@flowdoc/core';
import {specimen} from './fontHeightDeliveryFixture.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createFontAdminClient} from '../dist/fonts/client.js';
import {inspectFont} from '../dist/fonts/inspection.js';
import {fingerprint} from '../dist/fonts/repository.js';
// Isolated public-API/MCP verification only. Never a production importer.
const [action,configFile]=process.argv.slice(2),config=JSON.parse(await readFile(configFile,'utf8')),out=dirname(resolve(configFile));
assert.match(config.container,/^flowdoc-height-stage4-(api|restore|runtime)$/);assert.equal(new URL(config.url).hostname,'127.0.0.1');
const sha=b=>createHash('sha256').update(b).digest('hex'),stateFile=join(out,'state.json'),receipts=[];
const save=(name,value)=>writeFile(join(out,name),JSON.stringify(value,null,2)+'\n');
let state=await readFile(stateFile,'utf8').then(JSON.parse).catch(()=>({families:[],pdfs:[],checks:[]}));
const mut=(revision,extra={})=>({requestId:randomUUID(),reason:'Isolated phase 4 verification; no production approval',expectedRevision:revision,...extra});
const admin=createFontAdminClient({baseUrl:config.url,token:process.env.FONT_ADMIN_TOKEN});
async function cli(command,input){const r=await admin.execute(command,input);receipts.push({command,input,result:r});assert(r.ok,JSON.stringify(r));return r.value;}
const f=path=>join(process.env.HEIGHT_SUPPLIED_DIR,path);
const sources=[
 {key:'thsarabunnew',custom:true,prefix:'THSarabunNew/THSarabunNew',suffixes:['.ttf',' Bold.ttf',' Italic.ttf',' BoldItalic.ttf']},
 {key:'sarabun',prefix:'IBM_Plex_Sans_Thai,Pridi,Sarabun/Sarabun/Sarabun-',suffixes:['Regular.ttf','Bold.ttf','Italic.ttf','BoldItalic.ttf']},
 {key:'ibm-plex-sans-thai',prefix:'IBM_Plex_Sans_Thai,Pridi,Sarabun/IBM_Plex_Sans_Thai/IBMPlexSansThai-',suffixes:['Regular.ttf','Bold.ttf']},
 {key:'pridi',prefix:'IBM_Plex_Sans_Thai,Pridi,Sarabun/Pridi/Pridi-',suffixes:['Regular.ttf','Bold.ttf']},
 {key:'noto-sans-thai-looped',prefix:'Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Noto_Sans_Thai_Looped/static/NotoSansThaiLooped-',suffixes:['Regular.ttf','Bold.ttf']},
 {key:'noto-serif-thai',prefix:'Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Noto_Serif_Thai/static/NotoSerifThai-',suffixes:['Regular.ttf','Bold.ttf']},
 {key:'prompt',prefix:'Noto_Sans_Thai_Looped,Noto_Serif_Thai,Prompt/Prompt/Prompt-',suffixes:['Regular.ttf','Bold.ttf','Italic.ttf','BoldItalic.ttf']}];
async function review(release,key){
 const submitted=await cli('review-submit',{id:release.id,...mut(release.revision,{manifestDigest:release.manifestDigest})});
 const run=await cli('review-run',{id:submitted.reviewId,...mut(submitted.revision,{manifestDigest:release.manifestDigest})});assert(run.report.ok,JSON.stringify(run));
 const artifacts=[];for(const [i,face]of run.report.faces.entries()){
  const r=await fetch(config.url+`/admin/fonts/reviews/${submitted.reviewId}/artifacts/${face.artifactHash}`,{headers:{authorization:'Bearer '+process.env.FONT_ADMIN_TOKEN}});assert(r.ok);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(sha(bytes),face.artifactHash);const path=join(out,'review-pdf',key+'-'+i+'.pdf');await writeFile(path,bytes);artifacts.push({...face,path});
 }return {...release,reviewId:submitted.reviewId,revision:run.revision,reportDigest:run.reportDigest,artifacts};
}
async function prepare(){
 for(const source of sources){if(state.families.some(x=>x.key===source.key))continue;
  const files=source.suffixes.map(s=>f(source.prefix+s)),metadata=await Promise.all(files.map(p=>inspectFont(p))),bytes=await Promise.all(files.map(p=>readFile(p)));
  const faces=files.map((path,i)=>({path,clientKey:'f'+i,approvedWeight:i%2===0?400:700,style:i<2?'normal':'italic',sha256:sha(bytes[i]),metadata:metadata[i]}));
  for(const face of faces)assert.equal(face.style,face.metadata.style);
  let license;if(source.custom){license=join(out,'th-license.txt');await writeFile(license,metadata[0].names.license,'utf8');}else{let folder=dirname(files[0]);if(folder.endsWith('static'))folder=dirname(folder);license=join(folder,'OFL.txt');}
  const provenance={sourceName:metadata[0].names.family,sourceVersion:metadata[0].fileVersion,obtainedFrom:'Owner supplied font download',rightsNote:source.custom?'Exact license from name ID13; source SHA256 '+faces[0].sha256:'Original source package license preserved'};
  const family=await cli('family-create',{requestId:randomUUID(),reason:'Isolated supplied font verification',displayName:metadata[0].names.family,internalNames:[...new Set(metadata.map(x=>x.names.family))],sourceIdentity:{provider:source.custom?'custom':'google-fonts',providerFamilyKey:source.key}});
  const imported=await cli('import',{requestId:randomUUID(),reason:'User supplied files; three weight values retained',files:faces.map(({clientKey,path})=>({clientKey,path})),licenseFiles:[{clientKey:'license',path:license}],sourceEvidence:faces.map(face=>({clientKey:face.clientKey,provider:source.custom?'custom':'google-fonts',locator:source.custom?'urn:flowdoc:custom:'+source.key:'https://fonts.google.com/specimen/'+encodeURIComponent(metadata[0].names.family),retrievedAt:'2026-10-16T00:00:00Z',metadataHash:fingerprint(provenance),fileHashBinding:face.sha256,sourceWeight:null,licenseClientKeys:['license'],...(source.custom?{providerFamilyKey:source.key,provenance}:{})}))});
  const inspected=await cli('import-inspect',{id:imported.id,...mut(0)});
  const stage=async(version,members)=>cli('release-stage',{requestId:randomUUID(),reason:'Explicit face roles Regular400/Bold700; file values and unknown upstream weights preserved',familyId:family.id,version,importId:imported.id,languageScope:['th','en'],faceBindings:members.map(face=>{const i=inspected.files.find(x=>x.clientKey===face.clientKey);return {assetId:i.assetId,sourceEvidenceId:i.sourceEvidenceId,sourceWeight:null,approvedWeight:face.approvedWeight,style:face.style,conflictResolution:{reason:'Operator assigns explicit face role; upstream weight unknown, original file value retained',sourceWeight:null,approvedWeight:face.approvedWeight}};})});
  const full=await review(await stage(1,faces),source.key);const profile=await cli('height-measure',{id:full.id,...mut(full.revision,{manifestDigest:full.manifestDigest})});assert.equal(profile.outcome,'measured');
  const entry={key:source.key,family,faces,release:full,profile,missingFaces:faces.length===2?['italic400','italic700']:[]};if(source.key==='sarabun')entry.alternative=await review(await stage(2,[faces[0]]),'sarabun-v2');
  state.families.push(entry);await save('state.json',state);console.log(JSON.stringify({family:source.key,faces:faces.length,top:profile.topDesign,status:'review-artifacts-await-visual-check'}));
 }
}
async function activate(){
 const visual=JSON.parse(await readFile(join(out,'review-visual.json'),'utf8'));assert.equal(visual.status,'PASS');
 for(const entry of state.families){for(const release of [entry.release,entry.alternative].filter(Boolean)){
  if(release.state==='active')continue;for(const a of release.artifacts)assert(visual.files.some(x=>x.sha256===a.artifactHash&&x.status==='PASS'));
  const approved=await cli('review-approve',{id:release.reviewId,...mut(release.revision,{manifestDigest:release.manifestDigest,reportDigest:release.reportDigest,artifactHashes:release.artifacts.map(a=>a.artifactHash)})});
  Object.assign(release,await cli('activate',{id:release.id,...mut(approved.revision,{reviewId:release.reviewId,manifestDigest:release.manifestDigest})}));
 }
 const p=entry.profile;await cli('height-approve',{id:p.id,...mut(entry.release.revision,{profileDigest:p.profileDigest})});await cli('height-assign',{id:entry.release.id,...mut(0,{profileId:p.id,profileDigest:p.profileDigest})});await save('state.json',state);
 }
}
async function connect(){
 const load=p=>import(pathToFileURL(join(config.serviceRoot,p)).href),{Client}=await load('node_modules/@modelcontextprotocol/client/dist/index.mjs'),{StdioClientTransport}=await load('node_modules/@modelcontextprotocol/client/dist/stdio.mjs'),wire=JSON.parse(await readFile(join(config.pluginRoot,'.mcp.json'),'utf8')).mcpServers.flowdocmake;
 const client=new Client({name:'font-height-phase4',version:'1'}),transport=new StdioClientTransport({...wire,command:process.execPath,env:{...process.env,FLOWDOCMAKE_CONFIG:resolve(configFile)},stderr:'pipe'});try{await client.connect(transport);
 const tool=async(name,args,success=true)=>{const response=await client.callTool({name,arguments:args}),r=JSON.parse(response.content[0].text);receipts.push({tool:name,args,result:r});assert.equal(!response.isError&&r.ok!==false,success,JSON.stringify(r));return r.value??r;};
 const preflight=await tool('get_flowdocmake_context',{});assert.equal(preflight.ready,true);await save('candidate-preflight-'+config.container+'.json',preflight);await save('tool-schemas.json',await client.listTools());await tool('get_authoring_contract',{});
 return {tool,close:async()=>{await client.close();await transport.close();}};
 }catch(e){await client.close();await transport.close();throw e;}
}
async function preview(tool,draft,request,name){
 const job=await tool('preview_template_draft',{templateId:draft.templateId,expectedRevision:draft.revision,sampleRequest:request,idempotencyKey:randomUUID()});let status;
 for(let i=0;i<600;i++){status=await tool('get_preview_status',{jobId:job.jobId});if(['succeeded','failed'].includes(status.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(status.status,'succeeded',JSON.stringify(status));const pdf=await tool('save_preview_pdf',{jobId:job.jobId}),path=join(out,'pdf',name+'.pdf');await copyFile(pdf.path,path);assert.equal(sha(await readFile(path)),pdf.sha256);
 const record={name,path,...pdf,nativePath:pdf.path,jobId:job.jobId,templateId:draft.templateId,revision:draft.revision,fingerprint:draft.fingerprint,definition:draft.definition,request};record.path=path;state.pdfs=state.pdfs.filter(p=>p.name!==name);state.pdfs.push(record);await save('state.json',state);return record;
}
async function render(){
 const mcp=await connect();try{const {tool}=mcp,reference=state.families.find(e=>e.key==='thsarabunnew');assert(reference);for(const entry of state.families){if(entry.draft)continue;
  const identity=await tool('create_template_draft',{name:'Height specimen '+entry.key,docKey:'height-'+entry.key+'-'+randomUUID(),idempotencyKey:randomUUID()}),sizes=Object.fromEntries([10,16,24].map(n=>[n,calculateFontHeightAdjustment({fontSizePt:n,sourceMetric:{methodId:reference.profile.methodId,unitsPerEm:reference.profile.unitsPerEm,topDesign:reference.profile.topDesign},targetMetric:{methodId:entry.profile.methodId,unitsPerEm:entry.profile.unitsPerEm,topDesign:entry.profile.topDesign}}).value.fontSizePt]));
  const fixture=specimen(entry,reference,identity,sizes);await tool('validate_template',{definition:fixture.definition,sampleRequest:fixture.request});let draft=await tool('update_template_draft',{templateId:identity.templateId,expectedRevision:identity.revision,definition:fixture.definition,idempotencyKey:randomUUID()});assert.equal(draft.fontReadiness.status,'ready');
  for(const item of fixture.adjustments){const before=structuredClone(draft),proposal=await tool('propose_font_height_adjustment',{templateId:draft.templateId,expectedRevision:draft.revision,styleId:item.styleId,targetFont:item.targetFont,idempotencyKey:randomUUID()});assert.equal(proposal.status,'proposed');assert.equal(proposal.layoutCheck,'not_checked');assert.equal(proposal.proposedFontSizePt,item.expected);
   assert.equal((await tool('get_template_draft',{templateId:draft.templateId})).revision,draft.revision);draft=await tool('confirm_font_height_adjustment',{templateId:draft.templateId,proposalId:proposal.proposalId,expectedRevision:draft.revision,idempotencyKey:randomUUID()});const expected=before.definition;expected.styles[item.styleId].font=item.targetFont;expected.styles[item.styleId].fontSize.value=item.expected;assert.deepEqual(draft.definition,expected);
  }
  const reopened=await tool('get_template_draft',{templateId:draft.templateId});assert.deepEqual(reopened.definition,draft.definition);await tool('validate_template',{definition:draft.definition,sampleRequest:fixture.request});assert.equal((await tool('get_draft_font_readiness',{templateId:draft.templateId,expectedRevision:draft.revision,sampleRequest:fixture.request})).fontReadiness.status,'ready');
  entry.draft=draft;entry.fixture=fixture;entry.specimen=await preview(tool,draft,fixture.request,entry.key);await save('state.json',state);console.log(JSON.stringify({family:entry.key,revision:draft.revision,pdf:entry.specimen.path,sizes}));
 }}finally{await mcp.close();}
}
async function scenarios(){
 const mcp=await connect();try{const {tool}=mcp,sarabun=state.families.find(x=>x.key==='sarabun'),pridi=state.families.find(x=>x.key==='pridi');
 const current=await tool('get_template_draft',{templateId:sarabun.draft.templateId});assert.equal(current.fingerprint,sarabun.draft.fingerprint);
 const first=await cli('default-set',{id:sarabun.family.id,...mut(sarabun.family.revision,{releaseId:sarabun.release.id})}),changed=await cli('default-set',{id:sarabun.family.id,...mut(first.revision,{releaseId:sarabun.alternative.id})});
 const unchanged=await tool('get_template_draft',{templateId:current.templateId});assert.deepEqual(unchanged.definition,current.definition);assert.equal(unchanged.fingerprint,current.fingerprint);
 const defaultOld=await preview(tool,unchanged,sarabun.fixture.request,'default-old-pinned');assert.equal(defaultOld.sha256,sarabun.specimen.sha256);state.checks.push({case:'default change preserves old pinned definition and PDF bytes',status:'PASS',default:changed});
 async function single(name,definition){const identity=await tool('create_template_draft',{name,docKey:'height-check-'+randomUUID(),idempotencyKey:randomUUID()});definition=structuredClone(definition);definition.templateId=identity.templateId;definition.docKey=identity.docKey;definition.name=name;
  const source=definition.sections[0].source,roots=source.fragment.rootIds.slice(0,source.fragment.rootIds.indexOf('page-break'));source.fragment.rootIds=roots;source.fragment.nodes=Object.fromEntries(roots.map(k=>[k,source.fragment.nodes[k]]));const d=await tool('update_template_draft',{templateId:identity.templateId,expectedRevision:0,definition,idempotencyKey:randomUUID()});return {draft:d,request:{docKey:d.docKey,data:{},sections:{specimen:{data:{}}}}};
 }
 const defaultDefinition=structuredClone(current.definition);for(const style of Object.values(defaultDefinition.styles))if(style.font?.releaseId===sarabun.release.id)style.font={kind:'library',releaseId:sarabun.alternative.id,weight:400,style:'normal'};
 const fresh=await single('Explicit selection from new default',defaultDefinition),catalog=await tool('get_font_catalog',{});assert(catalog.releases.find(r=>r.releaseId===sarabun.alternative.id).isDefault);assert.equal(fresh.draft.fontReadiness.status,'ready');await preview(tool,fresh.draft,fresh.request,'default-new-explicit');
 const noProfile=await tool('propose_font_height_adjustment',{templateId:fresh.draft.templateId,expectedRevision:fresh.draft.revision,styleId:'same16',targetFont:{kind:'library',releaseId:sarabun.alternative.id,weight:400,style:'normal'},idempotencyKey:randomUUID()});assert.deepEqual(noProfile,{status:'unavailable',reason:'PROFILE_MISSING'});assert.equal((await tool('get_template_draft',{templateId:fresh.draft.templateId})).revision,fresh.draft.revision);state.checks.push({case:'missing profile leaves ordinary actual pt and PDF readiness intact',status:'PASS'});
 await cli('retire',{id:pridi.release.id,...mut(pridi.release.revision)});const retained=await tool('get_template_draft',{templateId:pridi.draft.templateId});assert.deepEqual(retained.definition,pridi.draft.definition);const retiredPdf=await preview(tool,retained,pridi.fixture.request,'retired-original');assert.equal(retiredPdf.sha256,pridi.specimen.sha256);
 const clone=await tool('clone_template_draft',{templateId:retained.templateId,sourceRevision:retained.revision,name:'Retained retired copy',docKey:'retired-copy-'+randomUUID(),idempotencyKey:randomUUID()});const targetFont={kind:'library',releaseId:pridi.release.id,weight:400,style:'normal'},p=await tool('propose_font_height_adjustment',{templateId:clone.templateId,expectedRevision:clone.revision,styleId:'adjust16',targetFont,idempotencyKey:randomUUID()});assert.equal(p.proposedFontSizePt,clone.definition.styles.adjust16.fontSize.value);const confirmed=await tool('confirm_font_height_adjustment',{templateId:clone.templateId,proposalId:p.proposalId,expectedRevision:clone.revision,idempotencyKey:randomUUID()});const clonePdf=await preview(tool,confirmed,{...pridi.fixture.request,docKey:clone.docKey},'retired-clone');assert.equal(clonePdf.sha256,pridi.specimen.sha256);
 const prohibited=await single('No retained rights',pridi.draft.definition);assert.notEqual(prohibited.draft.fontReadiness.status,'ready');const denial=await tool('propose_font_height_adjustment',{templateId:prohibited.draft.templateId,expectedRevision:prohibited.draft.revision,styleId:'label',targetFont,idempotencyKey:randomUUID()},false);assert.equal(denial.issues[0].code,'FONT_TARGET_UNAVAILABLE');state.checks.push({case:'retired original and clone keep byte-identical PDF; fresh JSON cannot grant tuple',status:'PASS'});
 const legacyDefinition=structuredClone(current.definition);legacyDefinition.schemaVersion=1;for(const [key,style]of Object.entries(legacyDefinition.styles))legacyDefinition.styles[key]={fontFamilyKey:'sarabun',fontWeight:style.font.weight>=700?'bold':'normal',fontStyle:style.font.style,fontSize:style.fontSize,lineHeightPt:style.lineHeightPt};
 const legacy=await single('Legacy Sarabun ordinary pt',legacyDefinition);const lp=await tool('propose_font_height_adjustment',{templateId:legacy.draft.templateId,expectedRevision:legacy.draft.revision,styleId:'same16',targetFont:{kind:'library',releaseId:sarabun.alternative.id,weight:400,style:'normal'},idempotencyKey:randomUUID()});assert.equal(lp.reason,'LEGACY_STYLE_UNSUPPORTED');const legacyPdf=await preview(tool,legacy.draft,legacy.request,'legacy-sarabun');
 const lc=await tool('clone_template_draft',{templateId:legacy.draft.templateId,sourceRevision:legacy.draft.revision,name:'Legacy copy',docKey:'legacy-copy-'+randomUUID(),idempotencyKey:randomUUID()});assert.equal(lc.definition.schemaVersion,1);const lcp=await preview(tool,lc,{...legacy.request,docKey:lc.docKey},'legacy-sarabun-clone');assert.equal(legacyPdf.sha256,lcp.sha256);state.checks.push({case:'legacy schema1 helper unavailable; ordinary pt, preview and clone preserved',status:'PASS'});
 for(const e of state.families.filter(x=>x.missingFaces.length)){const denied=await tool('propose_font_height_adjustment',{templateId:e.draft.templateId,expectedRevision:e.draft.revision,styleId:'label',targetFont:{kind:'library',releaseId:e.release.id,weight:400,style:'italic'},idempotencyKey:randomUUID()},false);assert.equal(denied.issues[0].code,'FONT_TARGET_UNAVAILABLE');state.checks.push({case:e.key+' missing italic is rejected (not synthetic)',status:'PASS'});}
 state.scenariosDone=true;await save('state.json',state);console.log(JSON.stringify({checks:state.checks,pdfs:state.pdfs.length}));
 }finally{await mcp.close();}
}
async function collect(){const mcp=await connect();try{for(const pdf of state.pdfs){const d=await mcp.tool('get_template_draft',{templateId:pdf.templateId});assert.equal(d.revision,pdf.revision);assert.equal(d.fingerprint,pdf.fingerprint);pdf.definition=d.definition;}}finally{await mcp.close();}await save('state.json',state);}
async function restore(){const mcp=await connect();try{for(const pdf of state.pdfs){const d=await mcp.tool('get_template_draft',{templateId:pdf.templateId});assert.equal(d.revision,pdf.revision);assert.equal(d.fingerprint,pdf.fingerprint);assert.deepEqual(d.definition,pdf.definition);}
 const e=state.families.find(x=>x.key==='sarabun'),p=await cli('height-show',{id:e.profile.id});assert.equal(p.profileDigest,e.profile.profileDigest);
 const prior=JSON.parse(await readFile(join(out,'render-receipts.json'),'utf8')).findLast(r=>r.tool==='confirm_font_height_adjustment'&&r.args.templateId===e.draft.templateId);const retry=await mcp.tool('confirm_font_height_adjustment',prior.args);assert.deepEqual(retry,prior.result.value);const draft=await mcp.tool('get_template_draft',{templateId:e.draft.templateId});assert.equal(draft.revision,e.draft.revision);
 const proposed=await mcp.tool('propose_font_height_adjustment',{templateId:draft.templateId,expectedRevision:draft.revision,styleId:'adjust16',targetFont:{kind:'library',releaseId:e.release.id,weight:400,style:'normal'},idempotencyKey:randomUUID()});assert.equal(proposed.status,'proposed');assert.equal(proposed.proposedFontSizePt,draft.definition.styles.adjust16.fontSize.value);
 const proof=await preview(mcp.tool,draft,e.fixture.request,'restored-sarabun');assert.equal(proof.sha256,e.specimen.sha256);state.checks.push({case:'isolated dump+font/files restore keeps drafts/profiles/receipts and renders byte-identical PDF',status:'PASS'});state.restoreDone=true;await save('state.json',state);console.log(JSON.stringify({status:'PASS',verifiedPdfBindings:state.pdfs.length,distinctDrafts:new Set(state.pdfs.map(p=>p.templateId)).size,profile:true,receipt:true,pdf:proof.path,sha256:proof.sha256}));
 }finally{await mcp.close();}}
try{if(['prepare','activate'].includes(action)){const verified=await connect();await verified.close();}if(action==='prepare')await prepare();else if(action==='activate')await activate();else if(action==='render')await render();else if(action==='scenarios')await scenarios();else if(action==='collect')await collect();else if(action==='restore')await restore();else throw Error('Expected prepare / activate / render');}
finally{await save(action+'-receipts.json',receipts);}
