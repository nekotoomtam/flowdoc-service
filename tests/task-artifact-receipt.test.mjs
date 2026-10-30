import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateTemplate,prepareGeneration,composeDocument,loadBundledResources,createDocxEngine,PDF_STREAM_CONTRACT} from '@flowdoc/core';
import * as artifact from '../dist/tasks/artifact.js';

// The fallback is the pre-fix child bridge. It makes the RED exercise the
// oversized real receipt, rather than fail merely because an export is absent.
const project=(format,r)=>artifact.projectArtifactReceipt?.(format,r)??({...r,mediaType:artifact.artifactSpec(format).mediaType,...(format==='docx'?artifact.docxDisclosure:{})});
it('keeps a real 1800-record DOCX completion below the unchanged IPC guard without truncating Core diagnostics',async()=>{
 const sid='00000000-0000-4000-8000-000000000001',t=JSON.parse(await readFile('examples/area-document-template.json','utf8'));
 t.templateId=t.docKey='audit-fixture';t.name='audit-fixture';t.nodeModelVersion=19;t.version=1;t.examples=[];t.globalSchema={type:'object',fields:{}};
 t.areaFormats={item:{key:'item',ownerAreaId:'parts',inputSchema:{type:'object',fields:{message:{type:'string',required:true}}},repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'field-ref',scope:'local',key:'message'}]}}}}};
 t.sections=[{id:sid,label:'Audit',nameBase:'Audit',inputSchema:{type:'object',fields:{parts:{type:'area',areaId:'parts'}}},source:{kind:'authored',repeats:[],fragment:{rootIds:['parts'],nodes:{parts:{id:'parts',type:'area',props:{areaId:'parts'}}}}}}];
 const must=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
 const v=must(validateTemplate(t)),p=must(prepareGeneration(v,{docKey:t.docKey,data:{},sections:[{id:sid,data:{parts:Array.from({length:1800},(_,n)=>({format:'item',data:{message:'Record '+n+' — audit ownership text '+('bounded input '+n+' ').repeat(8)}}))}}]})),doc=must(composeDocument(v,p));
 const root=await mkdtemp(join(tmpdir(),'task-receipt-'));let bytes=0;
 try{
  const resources=must(await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot:root})),engine=must(await createDocxEngine(resources));
  const result=must(await engine.generateDocxTo(doc,{contract:PDF_STREAM_CONTRACT,images:{},async*open(){throw Error('Unexpected image');}},{async write(b){bytes+=b.length;},async abort(){bytes=0;}},{maxBytes:artifact.DOCX_MAX_BYTES}));
  expect(bytes).toBe(result.byteLength);expect(JSON.stringify(result).length).toBeGreaterThan(131072);
  const before=JSON.stringify(result),receipt=project('docx',result),complete={id:1,op:'complete',outputFormat:'docx',output:'lab-output.part',receipt,warningCount:0,warnings:[],summary:{version:1,scope:'expanded-image-nodes',imagePlacementCount:0,normalizedOmittedPlacementCount:0,preparationOmittedPlacementCount:0,omittedPlacementCount:0,findingCount:0,formatOmissionCount:0,completeness:'complete'}};
  expect(JSON.stringify(complete).length).toBeLessThanOrEqual(131072);
  expect(receipt).toEqual({byteLength:result.byteLength,sha256:result.sha256,pageCount:null,mediaType:artifact.artifactSpec('docx').mediaType,...artifact.docxDisclosure});
  expect(JSON.stringify(result)).toBe(before);expect(result.adaptations.length).toBeGreaterThan(1800);
  expect(()=>artifact.validateReceipt('docx',receipt,artifact.DOCX_MAX_BYTES)).not.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
},60000);

it('preserves PDF receipt fields and leaves frozen-format validation authoritative',()=>{
 const source=Object.freeze({byteLength:42,sha256:'a'.repeat(64),pageCount:3,adaptations:[{extra:'x'.repeat(200000)}]});
 const receipt=project('pdf',source);
 expect(Object.keys(receipt).sort()).toEqual(['byteLength','mediaType','pageCount','sha256']);
 expect(receipt).toEqual({byteLength:42,sha256:'a'.repeat(64),pageCount:3,mediaType:'application/pdf'});
 expect(()=>artifact.validateReceipt('pdf',receipt,42)).not.toThrow();
 expect(()=>artifact.validateReceipt('pdf',{...receipt,byteLength:43},42)).toThrow();
 expect(()=>artifact.validateReceipt('docx',receipt,artifact.DOCX_MAX_BYTES)).toThrow();
 expect(source.adaptations[0].extra.length).toBe(200000);
});
