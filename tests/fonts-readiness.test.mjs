import {it,expect} from 'vitest';
const api=await import('../dist/fonts/readiness.js').catch(()=>({}));
it('reports unselected and unknown releases separately from structural validation',async()=>{
 expect(api.checkFontReadiness).toBeTypeOf('function');
 const definition={schemaVersion:2,styles:{body:{font:{kind:'unselected'}}}};
 const r=await api.checkFontReadiness({query:async()=>({rows:[]})},definition,'a'.repeat(64));
 expect(r).toMatchObject({status:'blocked',checkedScope:'styles',issues:[{code:'FONT_NOT_SELECTED',path:'/styles/body/font',remedy:expect.any(String)}]});
 definition.styles.body.font={kind:'library',releaseId:'10000000-0000-4000-8000-000000000001',weight:400,style:'normal'};
 expect(await api.checkFontReadiness({query:async()=>({rows:[]})},definition,'b'.repeat(64))).toMatchObject({status:'blocked',issues:[{code:'FONT_RELEASE_NOT_FOUND'}]});
});
it('bounds diagnostics and marks infrastructure failures incomplete without disclosing paths',async()=>{
 expect(api.checkFontReadiness).toBeTypeOf('function');
 const definition={schemaVersion:2,styles:Object.fromEntries(Array.from({length:80},(_,i)=>['s'+i,{font:{kind:'unselected'}}]))};
 const r=await api.checkFontReadiness({query:async()=>({rows:[]})},definition,'a'.repeat(64));
 expect(r.issues.length).toBeLessThanOrEqual(16);expect(r.total).toBe(80);expect(r.truncated).toBe(true);
 definition.styles={body:{font:{kind:'library',releaseId:'10000000-0000-4000-8000-000000000001',weight:400,style:'normal'}}};
 const broken=await api.checkFontReadiness({query:async()=>{throw Error('/private/password');}},definition,'a'.repeat(64));
 expect(broken.status).toBe('incomplete');expect(JSON.stringify(broken)).not.toContain('/private');
});
it('locates missing code points without echoing document text',()=>{
 expect(api.locateMissingGlyphs).toBeTypeOf('function');
 const document={nodes:{p:{id:'p',type:'text-block',props:{textStyleId:'body'},children:[{id:'text',type:'text',text:'A🦄'}]}},sourceMap:{p:{sectionId:'main'}}};
 expect(api.locateMissingGlyphs(document,new Map([['body',new Set([65])]]))).toMatchObject([{styleIds:['body'],occurrences:[{nodeId:'p',inlineId:'text',codePointIndex:1}],samples:['U+1F984']}]);
});
