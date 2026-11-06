import {readFileSync} from 'node:fs';
import sharp from 'sharp';
import {id} from './model20.mjs';

const block=(name,children,props={})=>({id:name,type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body',...props},children});
const field=(scope,key)=>({id:'value',type:'field-ref',scope,key});
export function nativeModel20({images=false,key='m20-native'}={}){
 const t=JSON.parse(readFileSync('tests/fixtures/group-label/template.json','utf8'));
 Object.assign(t,{templateId:key,docKey:key,nodeModelVersion:20,name:'Small model20 A-B-A',areaFormats:{},examples:[]});
 const make=(sectionKey,n)=>{
  const nodes={text:block('text',[field('section','text')],{anchorId:'mark'}),refs:block('refs',[{id:'local',type:'reference',text:'LOCAL',target:'mark'},...(sectionKey==='B'?[{id:'cross',type:'reference',text:'CROSS-LAST',target:'mark',targetInstanceKey:'last'}]:[])])};
  const schema={type:'object',fields:{text:{type:'string',required:true}}};
  if(images&&sectionKey==='A'){schema.fields.photo={type:'image',required:true};nodes.photo={id:'photo',type:'image',props:{source:{scope:'section',key:'photo'},width:{value:30,unit:'pt'},height:{value:20,unit:'pt'}}};}
  const s={id:id(n),sectionKey,label:sectionKey,nameBase:sectionKey,inputSchema:schema,numbering:sectionKey==='A'?{mode:'restart',startAt:1}:{mode:'continue'},source:{kind:'authored',repeats:[],fragment:{rootIds:Object.keys(nodes),nodes}}};
  for(const band of ['header','footer'])s[band]={inputSchema:{type:'object',fields:{note:{type:'string',required:true}}},baseTextStyleId:'body',fragment:{rootIds:['band'],nodes:{band:block('band',[field(band,'note'),...(band==='footer'?[{id:'space',type:'text',text:' PAGE '},{id:'page',type:'system-page-field',field:'current',width:{value:20,unit:'pt'}}]:[])],band==='footer'?{pageFieldLayout:'compact'}:{})}}};
  return s;
 };
 t.sections=[make('A',11),make('B',12)];
 const sections=[['A','first','FIRST'],['B','middle','MIDDLE'],['A','last','LAST']].map(([sectionKey,instanceKey,text])=>({sectionKey,instanceKey,data:{text,...(images&&sectionKey==='A'?{photo:{assetKey:'tiny'}}:{})},header:{note:text+' HEADER'},footer:{note:text+' FOOTER'},...(images&&sectionKey==='A'?{assets:[{assetKey:'tiny',image:{upload:true}}]}:{})}));
 return {t,raw:{data:{},sections},request:{docKey:key,version:1,data:{},sections}};
}
export const contentType='multipart/form-data; boundary=m20-native';
export async function multipart(raw,{images=false}={}){
 const part=(name,bytes,type)=>Buffer.concat([Buffer.from('--m20-native\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+type+'\r\n\r\n'),Buffer.from(bytes),Buffer.from('\r\n')]);
 const parts=[part('payload',JSON.stringify(raw),'application/json')],sources=[];
 if(images)for(const [index,color]of [[0,{r:220,g:20,b:10}],[2,{r:10,g:30,b:220}]]){
  const bytes=await sharp({create:{width:20,height:10,channels:3,background:color}}).png().toBuffer();
  parts.push(part('/sections/'+index+'/assets/0/image',bytes,'image/png'));sources.push({index,bytes});
 }
 return {bytes:Buffer.concat([...parts,Buffer.from('--m20-native--\r\n')]),sources};
}
