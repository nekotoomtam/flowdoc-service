/** Bounded native Area18 specimens. Text is test data, not copied pages. */
export const SAMPLE='บ กุ้ง น้ำ ปี่ ผู้ใหญ่ ญ ฐ ฎ ฏ ฤ ฦ ไทย ABC 0123456789';
export function specimen(entry,reference,{templateId,docKey},sizes){
 const styles={},nodes={},rootIds=[],expected=[];let seq=0;
 const font=(e,face)=>({kind:'library',releaseId:e.release.id,weight:face.approvedWeight,style:face.style});
 const normal=entry.faces.find(f=>f.approvedWeight===400&&f.style==='normal'),refNormal=reference.faces.find(f=>f.approvedWeight===400&&f.style==='normal');
 styles.label={font:font(reference,refNormal),fontSize:{value:12,unit:'pt'},lineHeightPt:18};styles.title={...styles.label,fontSize:{value:18,unit:'pt'},lineHeightPt:26};
 const add=(text,style='label',root=true)=>{const id='n'+(++seq);nodes[id]={id,type:'text-block',role:{role:'paragraph'},props:{textStyleId:style},children:[{id:id+'-text',type:'text',text}]};if(root)rootIds.push(id);expected.push({id,text,style});return id;};
 add(entry.key+' / SAME PT AND HEIGHT ADJUSTED','title');add('Reference: TH Sarabun New 1.35. Width and wrapping may differ.');
 for(const size of [10,16,24]){
  styles['same'+size]={font:font(entry,normal),fontSize:{value:size,unit:'pt'},lineHeightPt:32};
  styles['adjust'+size]={font:font(reference,refNormal),fontSize:{value:size,unit:'pt'},lineHeightPt:32};
  add('Same pt = '+size);add(SAMPLE,'same'+size);add('Adjusted from '+size+' pt; actual '+sizes[size]+' pt');add(SAMPLE,'adjust'+size);
 }
 add('PAGE1-END / '+entry.key);const pageBreak='page-break';nodes[pageBreak]={id:pageBreak,type:'page-break'};rootIds.push(pageBreak);
 add(entry.key+' / REAL FACES AND NARROW TABLE','title');
 for(const [i,face]of entry.faces.entries()){
  const refFace=reference.faces.find(f=>f.approvedWeight===face.approvedWeight&&f.style===face.style);if(!refFace)throw Error('Missing reference face');
  styles['faceSame'+i]={font:font(entry,face),fontSize:{value:16,unit:'pt'},lineHeightPt:26};styles['faceAdjust'+i]={font:font(reference,refFace),fontSize:{value:16,unit:'pt'},lineHeightPt:26};
  add('Face '+face.approvedWeight+' '+face.style+' / same16 then adjusted '+sizes[16]);add(SAMPLE,'faceSame'+i);add(SAMPLE,'faceAdjust'+i);
 }
 if(entry.missingFaces.length)add('Italic absent: no synthetic face, no silent substitution.');
 add('Narrow cells / multiple lines / Thai upper and lower marks');
 const table='table',row='row',c1='c1',c2='c2';nodes[table]={id:table,type:'table',props:{headerRowCount:0,repeatHeaderRows:false},columns:[{width:{value:180,unit:'pt'}},{width:{value:180,unit:'pt'}}],rowIds:[row]};nodes[row]={id:row,type:'table-row',props:{allowBreak:true},cellIds:[c1,c2]};
 const text='กุ้ง น้ำ ปี่ ผู้ใหญ่ กำลังเรียนรู้\nญ ฐ ฎ ฏ ใต้บรรทัด\nABC 0123456789';
 // Explicit line-break inline nodes preserve the line boundaries.
 for(const [cell,style]of [[c1,'same16'],[c2,'adjust16']]){const id=add(text,style,false);nodes[id].children=text.split('\n').flatMap((text,i)=>[...(i?[{id:id+'-br'+i,type:'line-break'}]:[]),{id:id+'-line'+i,type:'text',text}]);nodes[cell]={id:cell,type:'table-cell',props:{},childIds:[id]};}rootIds.push(table);add('PAGE2-END / '+entry.key);
 const L=value=>({value,unit:'mm'}),definition={schemaVersion:2,nodeModelVersion:18,templateId,docKey,version:1,name:'Font height '+entry.key,book:{contentSlot:'body',defaultPageLayoutId:'normal'},globalSchema:{type:'object',fields:{}},styles,examples:[],pageLayouts:{normal:{page:{size:'A4',orientation:'portrait',margin:{top:L(18),right:L(18),bottom:L(18),left:L(18)}}}},sections:[{id:'specimen',key:'specimen',source:{kind:'authored',fragment:{rootIds,nodes},repeats:[]},inputSchema:{type:'object',fields:{}},formats:{}}],areaFormats:{}};
 const adjustments=[...Object.keys(styles).filter(k=>k.startsWith('adjust')).map(k=>({styleId:k,targetFont:font(entry,normal),expected:sizes[Number(k.slice(6))]})),...entry.faces.map((face,i)=>({styleId:'faceAdjust'+i,targetFont:font(entry,face),expected:sizes[16]}))];
 return {definition,request:{docKey,data:{},sections:{specimen:{data:{}}}},adjustments,expected};
}
