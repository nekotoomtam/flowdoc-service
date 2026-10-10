import {loadBundledResources,createPdfEngine,composeDocument,validateTemplate} from '@flowdoc/core';
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import type {PdfImageResources} from '@flowdoc/core';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const temporary=process.env.FLOWDOC_RENDER_TEMP!;
try{
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));const t=validateTemplate(input.template);if(!t.ok)throw Error('template');
 const doc=input.imageInput?{ok:true,value:input.imageInput.document}:composeDocument(t.value,input.prepared);if(!doc.ok)throw Error('composition');
 const images:PdfImageResources={};sharp.cache(false);sharp.concurrency(1);
 for(const [id,raw] of Object.entries(input.imageInput?.images??{})){
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
