import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble,normalizeAreaDeletions} from '../dist/templates/assembly.js';
const fixture=()=>JSON.parse(readFileSync('examples/page-sections-template.json','utf8'));
it('preserves sections/layout identities and payload on relational roundtrip',()=>{
 const t=fixture(),r=decompose(t,randomUUID);expect(assemble(r,1)).toEqual(t);
 r.payload.pageLayouts.portrait.label='Renamed';const a=assemble(r,2);expect(a.sections).toEqual(t.sections);expect(a.book).toEqual(t.book);expect(a.version).toBe(2);
});
it('removes deleted global Area placement from authored section without changing old record',()=>{
 const t=fixture();t.globalSchema.fields.details={type:'area',areaId:'static-area'};
 const f=structuredClone(t.areaFormats['format-002']);f.ownerAreaId='static-area';t.areaFormats.static=f;
 t.sections[0].source.fragment.rootIds.push('area');t.sections[0].source.fragment.nodes.area={id:'area',type:'area',props:{areaId:'static-area'}};
 const current=decompose(t,randomUUID),r=structuredClone(current),v=r.variables.find(v=>v.payload.areaId==='static-area');r.variables=r.variables.filter(x=>x.id!==v.id);
 const result=normalizeAreaDeletions(current,r);
 expect(result.payload.sections[0].source.fragment.rootIds).not.toContain('area');expect(result.payload.sections[0].source.fragment.nodes.area).toBeUndefined();
 expect(current.payload.sections[0].source.fragment.nodes.area).toBeDefined();expect(result.formats.some(f=>f.ownerAreaVariableId===v.id)).toBe(false);
});
