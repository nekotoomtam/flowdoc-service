import {loadBundledResources,createPdfEngine,composeDocument,validateTemplate} from '@flowdoc/core';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import type {PdfImageResources,PreparedInput,TemplateDefinition} from '@flowdoc/core';
import type {JobImageInput} from '../images/job.js';
import {join} from 'node:path';
type RenderInput={mode:'document';imageInput:JobImageInput}|{mode:'compose';template:TemplateDefinition;prepared:PreparedInput};
async function readInput():Promise<RenderInput>{
 // Node's decoder preserves multibyte characters split across pipe chunks.
 // Keep the temporary JSON text scoped here, not alongside the rendered document.
 process.stdin.setEncoding('utf8');let text='';
 for await(const chunk of process.stdin)text+=chunk;
 return JSON.parse(text) as RenderInput;
}
const temporary=process.env.FLOWDOC_RENDER_TEMP!;
try{
 const input=await readInput();
 if(input.mode!=='document'&&input.mode!=='compose')throw Error('render input');
 const imageInput=input.mode==='document'?input.imageInput:undefined;
 const doc=(()=>{
  if(input.mode==='document')return {ok:true as const,value:input.imageInput.document};
  const t=validateTemplate(input.template);if(!t.ok)throw Error('template');
  return composeDocument(t.value,input.prepared);
 })();if(!doc.ok)throw Error('composition');
 const images:PdfImageResources={};sharp.cache(false);sharp.concurrency(1);
 for(const [id,raw] of Object.entries(imageInput?.images??{})){
  const i=raw as {path:string;width:number;height:number;mediaType:string};
  if(i.mediaType==='image/jpeg')images[id]={kind:'jpeg',width:i.width,height:i.height,bytes:await readFile(i.path)};
  else{
   const {data,info}=await sharp(i.path,{limitInputPixels:8_000_000,failOn:'warning'}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
   if(info.width!==i.width||info.height!==i.height||info.channels!==4)throw Error('Prepared image mismatch');
   const pixels=i.width*i.height,bytes=new Uint8Array(pixels*3),alpha=new Uint8Array(pixels);
   for(let p=0;p<pixels;p++){bytes[p*3]=data[p*4]!;bytes[p*3+1]=data[p*4+1]!;bytes[p*3+2]=data[p*4+2]!;alpha[p]=data[p*4+3]!;}
   images[id]={kind:'rgb',width:i.width,height:i.height,bytes,alpha};
  }
 }
 const resources=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot:temporary});if(!resources.ok)throw Error('resources');
 const engine=await createPdfEngine(resources.value);if(!engine.ok)throw Error('engine');
 const pdf=await engine.value.generatePdf(doc.value,images);if(!pdf.ok){await writeFile(join(temporary,'issues.json'),JSON.stringify(pdf.issues.filter(i=>i.code==='LAYOUT_FAILED').slice(0,16)));throw Error('render');}
 await writeFile(join(temporary,'warnings.json'),JSON.stringify(pdf.warnings));
 process.stdout.write(pdf.value.bytes);
}catch{process.exitCode=1;}finally{}
