import {it,expect} from 'vitest';
const api=await import('../dist/fonts/retention.js').catch(()=>({}));
const legacy=await import('../dist/fonts/legacy.js').catch(()=>({}));
it('keeps verified legacy hashes as server-owned provenance without requiring the PDF runtime to save',()=>{
 expect(legacy.LEGACY_SARABUN).toHaveLength(4);expect(new Set(legacy.LEGACY_SARABUN.map(f=>f.sha256)).size).toBe(4);
 expect(legacy.LEGACY_SARABUN.every(f=>f.origin==='verified_legacy'&&/^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);
});
it('extracts unique exact tuples independent of style names and never treats JSON as a grant',()=>{
 expect(api.fontTuples).toBeTypeOf('function');
 const font={kind:'library',releaseId:'10000000-0000-4000-8000-000000000001',weight:400,style:'normal'};
 expect(api.fontTuples({schemaVersion:2,styles:{a:{font},b:{font},c:{font:{kind:'unselected'}}}})).toEqual([{releaseId:font.releaseId,weight:400,style:'normal'}]);
 expect(api.fontTuples({schemaVersion:1,styles:{a:{fontFamily:'Sarabun'}}})).toEqual([]);
});
