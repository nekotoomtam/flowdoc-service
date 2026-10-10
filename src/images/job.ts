import {mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ResolvedDocument,Issue,Length} from '@flowdoc/core';
import type {ResourceFiles} from '../storage/resource-files.js';
import type {UploadConfig} from '../uploads/config.js';
import {transaction} from '../db/connection.js';
import {prepareImage} from './prepare.js';
import {downloadImage} from './download.js';
export interface RenderImage {path:string;width:number;height:number;mediaType:'image/jpeg'|'image/png'}
export interface JobImageInput {document:ResolvedDocument;images:Record<string,RenderImage>}
export interface ImageJobDependencies {files:ResourceFiles;config:UploadConfig}
export async function processing(pool:Pool,id:string,stage:string,completed:number,total:number,warnings:Issue[]){
 await pool.query(`INSERT INTO job_processing(job_id,stage,completed,total,warnings_json) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(job_id) DO UPDATE SET stage=$2,completed=$3,total=$4,warnings_json=$5,updated_at=now()`,[id,stage,completed,total,JSON.stringify(warnings)]);
}
export async function prepareJobImages(pool:Pool,jobId:string,doc:ResolvedDocument,deps:ImageJobDependencies,signal:AbortSignal):Promise<JobImageInput>{
 const document=structuredClone(doc),nodes=[...Object.values(document.nodes),...Object.values(document.header?.nodes??{}),...Object.values(document.footer?.nodes??{})].filter(n=>n.type==='image');
 const images:Record<string,RenderImage>={},warnings:Issue[]=[],sources=new Map<string,string|null>(),derivatives=new Map<string,string|null>();
 let completed=0,aggregate=0;await processing(pool,jobId,'preparing-resources',0,nodes.length,warnings);
 const abort=AbortSignal.any([signal,AbortSignal.timeout(300000)]),directory=deps.files.jobDirectory(jobId);if(nodes.some(n=>n.props.resourceId))await mkdir(directory,{recursive:true});
 const upload=(await pool.query('SELECT upload_id FROM upload_job_claims WHERE job_id=$1',[jobId])).rows[0]?.upload_id;
 const reserve=async(delta:number)=>transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(60430405)');
  const row=(await c.query('SELECT reserved_bytes,deleted_at FROM upload_sessions WHERE id=$1 FOR UPDATE',[upload])).rows[0];if(!row||row.deleted_at)throw Error('Resource ownership unavailable');
  if(delta>0){const total=Number((await c.query('SELECT coalesce(sum(reserved_bytes),0) AS bytes FROM upload_sessions WHERE deleted_at IS NULL')).rows[0].bytes);if(total+delta>deps.config.stagingBytes||Number(row.reserved_bytes)+delta>deps.config.setBytes+64*1048576)throw Error('Resource staging budget');}
  await c.query('UPDATE upload_sessions SET reserved_bytes=reserved_bytes+$2 WHERE id=$1',[upload,delta]);
 });
 const pt=(n:Length)=>n.unit==='mm'?n.value*72/25.4:n.value;
 for(const node of nodes){
  abort.throwIfAborted();const resourceId=node.props.resourceId,path='nodes.'+node.id;
  try{
   if(!resourceId){node.props.resourceId='';continue;}
   const item=(await pool.query('SELECT * FROM upload_items WHERE upload_id=$1 AND id=$2',[upload,resourceId])).rows[0];
   if(!item)throw Error('Missing resource');
   if(!sources.has(resourceId)){
    sources.set(resourceId,null);
    if(item.source_kind==='upload'){if(item.status!=='received'||!item.storage_key)throw Error('Missing original');sources.set(resourceId,deps.files.path(item.storage_key));}
    else{
     const budget=Math.min(deps.config.fileBytes,50*1048576),file=join(directory,randomUUID()+'.bin');await reserve(budget);
     let bytes=0;try{bytes=await downloadImage(item.source_url,file,abort,budget);sources.set(resourceId,file);}finally{await reserve(bytes-budget);}
    }
   }
   const source=sources.get(resourceId);if(!source)throw Error('Source unavailable');
   const w=pt(node.props.width),h=pt(node.props.height),key=(item.checksum??resourceId)+':'+Math.ceil(w*200/72)+':'+Math.ceil(h*200/72);
   if(!derivatives.has(key)){
    derivatives.set(key,null);if(Object.keys(images).length>=20)throw Error('Image count budget');
    const budget=32*1048576;await reserve(budget);let retained=0;
    try{
     const prepared=await prepareImage({sourcePath:source,outputDirectory:directory,widthPt:w,heightPt:h,signal:abort});
     warnings.push(...prepared.warnings.map(i=>({...i,path})));
     if(prepared.status==='prepared'){
      const i=prepared.image,size=i.mediaType==='image/png'?i.width*i.height*4:i.byteSize;
      if(aggregate+size>64*1048576){await unlink(i.path);throw Error('Image memory budget');}
      aggregate+=size;retained=i.byteSize;const id=randomUUID();images[id]=i;derivatives.set(key,id);
     }
    }finally{await reserve(retained-budget);}
   }
   node.props.resourceId=derivatives.get(key)??'';
  }catch{
   abort.throwIfAborted();node.props.resourceId='';warnings.push({code:'IMAGE_UNUSABLE',path,message:'Image unavailable or exceeded preparation limits'});
  }finally{completed++;await processing(pool,jobId,'preparing-resources',completed,nodes.length,warnings);}
 }
 await processing(pool,jobId,'rendering',completed,nodes.length,warnings);return {document,images};
}
