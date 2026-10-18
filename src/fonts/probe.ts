import type {ResolvedDocument} from '@flowdoc/core';
import {continuationLabelIds,continuationSuffix} from './group-labels.js';
/** Build a temporary font specimen from composed text. Core still validates,
 * shapes and embeds it; authored pagination is checked separately by the job. */
export function fontProbeDocument(document:ResolvedDocument):ResolvedDocument{
 const nodes:Record<string,any>={},sourceMap:Record<string,any>={},rootIds:string[]=[],seen=new Set<string>();
 const label=(c:any)=>c.type==='system-page-field'?'0123456789':c.type==='line-break'?'\n':c.type==='url'?c.value:c.text??'';
 const headings:string[]=[],contents:string[]=[];const blocks:{style:string;text:string}[]=[],labels=continuationLabelIds(document);
 const visit=(v:any)=>{
  if(!v||typeof v!=='object')return;
  if(v.type==='text-block'&&!seen.has(v.id)){
   seen.add(v.id);const text=(v.children??[]).map(label).join('');blocks.push({style:v.props.textStyleId,text:text+(labels.has(v.id)?continuationSuffix:'')});if(v.props.toc)headings.push(text);
  }else if(v.type==='table-of-contents'&&!contents.includes(v.props.textStyleId))contents.push(v.props.textStyleId);
  for(const x of Object.values(v))if(x&&typeof x==='object')Array.isArray(x)?x.forEach(visit):visit(x);
 };visit(document);
 for(const style of contents)blocks.push({style,text:headings.join('\n')+'\n0123456789'});
 if(!blocks.length)blocks.push({style:Object.keys(document.styles)[0]!,text:''});
 for(const b of blocks){
  // Split by Unicode code point so a supplementary glyph is never cut in half.
  const chunks:string[]=[];let text='';
  for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(b.text)){if(text.length+segment.length>2048&&text){chunks.push(text);text='';}text+=segment;}chunks.push(text);
  for(const text of chunks){
   const id='font-probe-'+rootIds.length,inline=id+'-text';rootIds.push(id);
   nodes[id]={id,type:'text-block',role:{role:'paragraph'},props:{textStyleId:b.style},children:text?[{id:inline,type:'text',text}]:[]};
   for(const key of text?[id,inline]:[id])sourceMap[key]={origin:'authored',sectionId:'font-probe',sourceId:key};
  }
 }
 const margin={value:20,unit:'mm' as const};
 const page={size:'A4' as const,orientation:'portrait' as const,margin:{top:margin,right:margin,bottom:margin,left:margin}};
 return {schemaVersion:document.schemaVersion,nodeModelVersion:18,template:document.template,book:{contentSlot:'body',page},styles:Object.fromEntries(Object.entries(document.styles).map(([k,s])=>[k,{...s,fontSize:{value:12,unit:'pt'},lineHeightPt:20}])),nodes,sourceMap,rootIds,sections:[{sectionId:'font-probe',sourceKind:'authored',role:'body',pageLayoutId:'font-probe',page,rootIds,headerMode:'none',footerMode:'none'}]};
}
