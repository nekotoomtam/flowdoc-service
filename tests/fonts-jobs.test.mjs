import {it,expect} from 'vitest';
const api=await import('../dist/fonts/snapshot.js').catch(()=>({}));
it('rejects a changed persisted snapshot, renderer, definition or input identity before using resources',async()=>{
 expect(api.validateFontSnapshot).toBeTypeOf('function');
 for(const value of [null,{}, {version:1,manifestDigest:'a'.repeat(64),bindings:[]}])expect(()=>api.validateFontSnapshot(value,'d','i')).toThrow();
 const snapshot=api.makeFontSnapshot('d','i',[]);expect(api.validateFontSnapshot(snapshot,'d','i')).toEqual(snapshot);
 expect(()=>api.validateFontSnapshot(snapshot,'other','i')).toThrow();expect(()=>api.validateFontSnapshot(snapshot,'d','other')).toThrow();
 const changed=structuredClone(snapshot);changed.rendererIdentity.version='different';expect(()=>api.validateFontSnapshot(changed,'d','i')).toThrow();
});
