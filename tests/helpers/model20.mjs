import {readFileSync} from 'node:fs';
export const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const text=(value,scope='section')=>({id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'value',type:'field-ref',scope,key:value}]});
export function model20Fixture({rich=false,schemaVersion=1}={}){
 const t=JSON.parse(readFileSync('tests/fixtures/group-label/template.json','utf8'));t.nodeModelVersion=20;t.sections[0].sectionKey='A';
 const a=t.sections[0];a.id=id(11);a.numbering={mode:'restart',startAt:1};
 for(const band of ['header','footer'])a[band]={inputSchema:{type:'object',fields:{note:{type:'string',required:true}}},baseTextStyleId:'body',fragment:{rootIds:['text'],nodes:{text:text('note',band)}}};
 t.sections.push({id:id(12),sectionKey:'B',label:'Middle',nameBase:'Middle',inputSchema:{type:'object',fields:{title:{type:'string',required:true}}},source:{kind:'authored',repeats:[],fragment:{rootIds:['text'],nodes:{text:text('title')}}}});
 const instance=(instanceKey,value)=>({sectionKey:'A',instanceKey,data:{content:[{format:'meeting',data:{companies:[{name:'G-'+value,members:[{name:value}]}]}}]},header:{note:value+' header'},footer:{note:value+' footer'}});
 t.examples=[{name:'A-B-A',request:{docKey:t.docKey,version:t.version,data:{},sections:[instance('first','FIRST'),{sectionKey:'B',instanceKey:'middle',data:{title:'MIDDLE'}},instance('last','LAST')]}}];
 t.areaFormats.meeting.sizing={mode:'fixed',height:{value:60,unit:'pt'}};
 if(rich){
  const f=t.areaFormats.meeting;f.inputSchema.fields.photo={type:'image',required:true};
  f.fragment.rootIds.push('photo','notes');f.fragment.nodes.photo={id:'photo',type:'image',props:{source:{scope:'local',key:'photo'},width:{value:20,unit:'pt'},height:{value:20,unit:'pt'}}};
  f.fragment.nodes.notes={id:'notes',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body',anchorId:'notes'},children:[{id:'url',type:'link',text:'Specification',url:'https://example.invalid/spec'},{id:'ref',type:'reference',text:'Local notes',target:'notes'}]};
  t.examples=[]; // Roundtrip fixture only; no invented image input or native resources.
 }
 if(schemaVersion===2){const style=t.styles.body;t.schemaVersion=2;t.styles.body={font:{kind:'library',releaseId:id(99),weight:400,style:'normal'},fontSize:style.fontSize,lineHeightPt:style.lineHeightPt};}
 return t;
}
