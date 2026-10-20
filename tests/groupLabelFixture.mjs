import {readFileSync} from 'node:fs';
export function fixture({fixed=false,height=180,name='GROUP',members=12}={}){
 const t=JSON.parse(readFileSync(new URL('./fixtures/group-label/template.json',import.meta.url)));
 const page=t.pageLayouts[t.book.defaultPageLayoutId].page;
 page.margin.top={value:10,unit:'pt'};page.margin.bottom={value:297*72/25.4-10-height,unit:'pt'};
 if(fixed)t.areaFormats.meeting.sizing={mode:'fixed',height:{value:300,unit:'pt'}};
 const area=Object.keys(t.sections[0].inputSchema.fields)[0];
 const q={docKey:t.docKey,data:{},sections:[{id:t.sections[0].id,data:{[area]:[{format:'meeting',data:{companies:[{name,members:Array.from({length:members},(_,i)=>({name:'ROW'+i}))}]}}]}}]};return {t,q};
}
