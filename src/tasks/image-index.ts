import {createHash,randomUUID} from 'node:crypto';import {createReadStream} from 'node:fs';import {open} from 'node:fs/promises';import sharp from 'sharp';
import type {TaskValue,TaskImageContext,TaskImageResource} from '@flowdoc/core';import {taskError} from './quota.js';
export interface ImageFinding{id:string;code:string;pointer:string;sectionId:string|null;affectedPlacementCount:number;locatorSha256?:string}
interface InputFile{id:string;logical_path:string;media_type:string;state:string;error_code:string|null;storage_key:string|null;stored_bytes:string;checksum:string|null}
interface Descriptor {key?:string;source:boolean;definition:boolean;error?:string}
interface Asset{assetId:string;sectionId:string|null;sourceFileId:string;sha256:string;width:number;height:number;mediaType:string}
interface Entry {context:TaskImageContext;descriptor:Descriptor;group:Group}
interface Group {entries:Entry[];definitions:Entry[];asset?:Asset;error?:string;findingId?:string}
export function createTaskImageIndex(deps:{files:InputFile[];pathFor:(key:string)=>Promise<string>;budgetBytes:number;maxDefinitions?:number;maxPlacements?:number;chargeBytes?:(bytes:number)=>void;signal?:AbortSignal;onFinding:(finding:ImageFinding)=>Promise<void>}){
 const entries=new Map<string,Entry>(),groups=new Map<string,Group>(),byPointer=new Map<string,InputFile[]>(),bound=new Set<string>(),used=new Set<string>(),assets=new Map<string,Asset>(),cache=new Map<string,Promise<{asset?:Asset;error?:string}>>();let budget=0,sealed=false,finished=false,omitted=0,placements=0,definitionCount=0,slotCount=0,findingCount=0;
 const charge=(n:number)=>{budget+=n;deps.chargeBytes?.(n);if(budget>deps.budgetBytes)throw taskError('LIMIT_EXCEEDED');};const check=()=>deps.signal?.throwIfAborted();
 for(const f of deps.files){charge(Buffer.byteLength(f.logical_path)+256);const list=byPointer.get(f.logical_path)??[];list.push(f);byPointer.set(f.logical_path,list);}
 const identity=(c:TaskImageContext)=>JSON.stringify([c.sectionId,c.pointer]);
 async function descriptor(v:TaskValue|undefined,c:TaskImageContext):Promise<Descriptor>{
  if(!v)return {source:false,definition:false,error:'IMAGE_SOURCE_MISSING'};
  if(await v.kind()!=='object')return {source:false,definition:false,error:'IMAGE_UNUSABLE'};
  let key:string|undefined,image:TaskValue|undefined,bad=false,named=false;
  for await(const [k,x] of v.properties()){check();if(k==='assetKey'){named=true;if(await x.kind()!=='scalar')bad=true;else{const a=await x.scalar();if(typeof a!=='string'||!a.length||Buffer.byteLength(a)>128)bad=true;else key=a;}}else if(k==='image')image=x;else bad=true;}
  if(c.assetDefinition&&!named||!named&&!image)bad=true;let source=false;
  if(image){if(await image.kind()!=='object')bad=true;else{let count=0;for await(const [k,x] of image.properties()){check();count++;if(k!=='upload'||await x.kind()!=='scalar'||await x.scalar()!==true)bad=true;}source=count===1&&!bad;if(!source)bad=true;}}
  return {...(key!==undefined?{key}:{}),source,definition:!!image||bad,...(bad?{error:'IMAGE_UNUSABLE'}:{})};
 }
 async function fileAsset(f:InputFile,sectionId:string|null){
  if(!cache.has(f.id))cache.set(f.id,(async()=>{
   if(f.state!=='received'||!f.storage_key)return {error:f.error_code==='IMAGE_LIMIT'?'IMAGE_LIMIT':'IMAGE_UNUSABLE'};
   try{check();const path=await deps.pathFor(f.storage_key),handle=await open(path,'r');let head:Buffer,tail:Buffer;try{head=Buffer.alloc(8);const read=await handle.read(head,0,8,0);head=head.subarray(0,read.bytesRead);const size=(await handle.stat()).size;tail=Buffer.alloc(Math.min(12,size));await handle.read(tail,0,tail.length,Math.max(0,size-tail.length));}finally{await handle.close();}
    const media=head.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':head.equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':null;if(!media||media!==f.media_type)return {error:'IMAGE_UNUSABLE'};if(media==='image/jpeg'&&!tail.subarray(-2).equals(Buffer.from([255,217]))||media==='image/png'&&!tail.equals(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130])))return {error:'IMAGE_UNUSABLE'};
    const hash=createHash('sha256');let bytes=0;for await(const b of createReadStream(path,{highWaterMark:65536,...(deps.signal?{signal:deps.signal}:{})})){check();bytes+=b.length;if(bytes>50*1048576)return {error:'IMAGE_LIMIT'};hash.update(b);}const sha=hash.digest('hex');if(bytes!==Number(f.stored_bytes)||sha!==f.checksum)return {error:'IMAGE_UNUSABLE'};
    const m=await sharp(path,{limitInputPixels:40_000_000,failOn:'warning'}).metadata();check();if(m.width&&m.height&&m.width*m.height>40_000_000)return {error:'IMAGE_LIMIT'};if(!m.width||!m.height||(m.pages??1)>1||m.format!==(media==='image/jpeg'?'jpeg':'png'))return {error:'IMAGE_UNUSABLE'};
    return {asset:{assetId:randomUUID(),sectionId,sourceFileId:f.id,sha256:sha,width:m.width,height:m.height,mediaType:media}};
   }catch(e){check();if(['EIO','EACCES','EROFS'].includes((e as any)?.code))throw taskError('STORAGE_IO');if(/pixel limit/i.test((e as any)?.message??''))return {error:'IMAGE_LIMIT'};return {error:(e as any)?.code==='ENOENT'?'IMAGE_SOURCE_MISSING':'IMAGE_UNUSABLE'};}
  })());return cache.get(f.id)!;
 }
 async function source(e:Entry){const d=e.descriptor;if(d.error)return {error:d.error};if(!d.source)return {error:'IMAGE_KEY_NOT_FOUND'};const list=byPointer.get(e.context.pointer+'/image')??[];if(list.length!==1)return {error:list.length?'IMAGE_SOURCE_CONFLICT':'IMAGE_SOURCE_MISSING'};return fileAsset(list[0]!,e.context.sectionId);}
 return {
  async collect(v:TaskValue|undefined,context:TaskImageContext){check();if(sealed)throw Error('Image index sealed');charge(Buffer.byteLength(context.pointer)+384);const d=await descriptor(v,context);if(d.definition&&++definitionCount>(deps.maxDefinitions??1000)||!context.assetDefinition&&++slotCount>(deps.maxPlacements??10000))throw taskError('LIMIT_EXCEEDED');if(d.key)charge(Buffer.byteLength(d.key));const id=identity(context);if(entries.has(id))throw taskError('INVALID_DATA');
   if(d.source)bound.add(context.pointer+'/image');const groupKey=d.key&&context.sectionId!==null?JSON.stringify(['key',context.sectionId,d.key]):id;let group=groups.get(groupKey);if(!group){group={entries:[],definitions:[]};groups.set(groupKey,group);}const e={context,descriptor:d,group};entries.set(id,e);group.entries.push(e);if(d.definition||!d.key)group.definitions.push(e);
  },
  async seal(){check();if(sealed)return;sealed=true;for(const g of groups.values()){check();if(!g.definitions.length){g.error='IMAGE_KEY_NOT_FOUND';continue;}const resolved=[];for(const e of g.definitions)resolved.push(await source(e));const bad=resolved.find(r=>r.error),good=resolved.filter(r=>r.asset).map(r=>r.asset!);
    if(resolved.length>1&&(bad||new Set(good.map(a=>a.sha256)).size!==1))g.error='IMAGE_SOURCE_CONFLICT';else if(bad)g.error=bad.error??'IMAGE_UNUSABLE';else if(good[0])g.asset=good[0];else g.error='IMAGE_UNUSABLE';
    if(g.entries.some(e=>e.descriptor.key&&e.context.sectionId===null)){g.error='IMAGE_KEY_NOT_FOUND';delete g.asset;}
   }
  },
  async resolve(context:TaskImageContext):Promise<TaskImageResource>{check();if(!sealed||finished)throw Error('Image index not resolving');const e=entries.get(identity(context));if(!e||e.context.assetDefinition)throw Error('Unknown typed image slot');placements++;const g=e.group;if(g.asset&&!g.error){used.add(g.asset.sourceFileId);assets.set(g.asset.assetId,g.asset);return {kind:'task-image',version:1,availability:'available',assetId:g.asset.assetId};}
   omitted++;g.findingId??=randomUUID();return {kind:'task-image',version:1,availability:'unavailable',reason:g.error??'IMAGE_UNUSABLE',findingId:g.findingId};
  },
  async finish(){check();if(!sealed||finished)throw Error('Image index not finalizable');finished=true;for(const g of groups.values()){if(!g.error)continue;const visible=g.entries.filter(e=>!e.context.assetDefinition);const c=(visible[0]??g.entries[0])!.context;g.findingId??=randomUUID();findingCount++;await deps.onFinding({id:g.findingId,code:g.error,pointer:c.pointer,sectionId:c.sectionId,affectedPlacementCount:visible.length});}
   const unboundFileIds=[];for(const f of deps.files)if(!bound.has(f.logical_path)){unboundFileIds.push(f.id);findingCount++;await deps.onFinding({id:randomUUID(),code:'IMAGE_PART_UNBOUND',pointer:f.logical_path,sectionId:null,affectedPlacementCount:0});}
   const sourceBindings=[];for(const e of entries.values())if(e.descriptor.source)for(const f of byPointer.get(e.context.pointer+'/image')??[])sourceBindings.push({fileId:f.id,sectionId:e.context.sectionId,assetKey:e.descriptor.key??null});
   return {assets:[...assets.values()],sourceBindings,findingCount,placementCount:placements,omittedPlacementCount:omitted,unusedUploadCount:deps.files.filter(f=>!used.has(f.id)).length,unboundFileIds,completeness:omitted?'partial':'complete'};
  }
 };
}
