import {it,expect} from 'vitest';
const api=await import('../dist/fonts/probe.js').catch(()=>({}));
it('checks actual body, band, table, TOC and field characters without applying authored pagination',()=>{
 expect(api.fontProbeDocument).toBeTypeOf('function');
 const p={id:'p',type:'text-block',props:{textStyleId:'body',heightMode:'fixed',height:{value:1,unit:'pt'},toc:{level:1}},children:[{id:'text',type:'text',text:'A🦄'},{id:'link',type:'url',value:'https://example.com'},{id:'field',type:'system-page-field',field:'current',width:{value:1,unit:'pt'}}]};
 const d={schemaVersion:2,nodeModelVersion:18,template:{templateId:'p',docKey:'p',version:1},book:{page:{size:'A4',orientation:'portrait',margin:{top:20,right:20,bottom:20,left:20}}},styles:{body:{font:{kind:'unselected'},fontSize:{value:1000,unit:'pt'},lineHeightPt:1000},toc:{font:{kind:'unselected'},fontSize:{value:12,unit:'pt'},lineHeightPt:20}},nodes:{p,toc:{id:'toc',type:'table-of-contents',props:{textStyleId:'toc'}}},sections:[{header:{nodes:{band:{...p,id:'band'}}}}]};
 const before=JSON.stringify(d),probe=api.fontProbeDocument(d);expect(JSON.stringify(d)).toBe(before);expect(probe.styles.body.font).toEqual(d.styles.body.font);expect(probe.styles.body.fontSize.value).toBe(12);
 const text=Object.values(probe.nodes).flatMap(n=>n.children??[]).map(c=>c.text).join('');expect(text).toContain('A🦄');expect(text).toContain('https://example.com');expect(text).toContain('0123456789');expect(probe.rootIds.length).toBeGreaterThan(2);
});
it('keeps empty text valid and supports documents containing only images',()=>{
 const base={schemaVersion:1,nodeModelVersion:18,template:{templateId:'p',docKey:'p',version:1},styles:{body:{fontFamilyKey:'sarabun',fontWeight:'normal',fontSize:{value:12,unit:'pt'},lineHeightPt:20}},nodes:{p:{id:'p',type:'text-block',props:{textStyleId:'body'},children:[]}}};
 const probe=api.fontProbeDocument(base);expect(probe.nodes[probe.rootIds[0]].children).toEqual([]);
 expect(Object.keys(probe.sourceMap)).toEqual(probe.rootIds);
 base.nodes={image:{id:'image',type:'image'}};expect(api.fontProbeDocument(base).rootIds).toHaveLength(1);
});
