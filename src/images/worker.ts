import sharp from 'sharp';
import {stat} from 'node:fs/promises';

sharp.cache(false);sharp.concurrency(1);
process.once('message',async(raw:unknown)=>{
 const input=raw as {source:string;output:string;width:number;height:number;widthPt:number;heightPt:number};
 try{
  const size=await stat(input.source);if(!size.isFile()||size.size>50*1048576)throw Error('Input limit');
  const options={limitInputPixels:40_000_000,failOn:'warning' as const};
  const metadata=await sharp(input.source,options).metadata();
  if(!['jpeg','png'].includes(metadata.format)||!metadata.width||!metadata.height||(metadata.pages??1)>1)throw Error('Unsupported image');
  const operation=sharp(input.source,options).autoOrient().toColourspace('srgb').resize({width:input.width,height:input.height,fit:'inside',withoutEnlargement:true});
  const result=await (metadata.format==='jpeg'?operation.jpeg({quality:90}):operation.png({compressionLevel:6})).toFile(input.output);
  const effectiveDpi=72/Math.min(input.widthPt/result.width,input.heightPt/result.height);
  process.send?.({ok:true,width:result.width,height:result.height,byteSize:result.size,effectiveDpi,mediaType:metadata.format==='jpeg'?'image/jpeg':'image/png'},undefined,undefined,()=>process.disconnect());
 }catch{
  process.send?.({ok:false},undefined,undefined,()=>process.disconnect());
 }
});
