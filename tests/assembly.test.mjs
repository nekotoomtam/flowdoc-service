import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateTemplate} from '@flowdoc/core';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
const original=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
it('round trips the Core envelope with scoped stable IDs and item children',()=>{
 const r=decompose(original,randomUUID);expect(assemble(r,1)).toEqual(original);
 expect(r.schemas).toHaveLength(3);expect(r.variables.some(v=>v.parentId)).toBe(true);
 expect(validateTemplate(assemble(r,1)).value.fingerprint).toBe(validateTemplate(original).value.fingerprint);
 const v=r.variables[0],id=v.id;v.key='renamed';expect(v.id).toBe(id);expect(assemble(r,1).globalSchema.fields.renamed).toBeDefined();
});
it('rejects duplicate root keys, cross-schema parents and cycles',()=>{
 const r=decompose(original,randomUUID);r.variables.push({...r.variables[0],id:randomUUID()});expect(()=>checkRecord(r)).toThrow();
 const s=decompose(original,randomUUID);s.variables[0].parentId=s.variables[0].id;expect(()=>checkRecord(s)).toThrow();
 const t=decompose(original,randomUUID);t.variables[0].parentId=t.variables.find(v=>v.schemaId!==t.variables[0].schemaId).id;expect(()=>checkRecord(t)).toThrow();
});
it('binds versioned examples to the newly published number without mutating current',()=>{
 const t=structuredClone(original);t.examples=[{name:'normal',request:JSON.parse(readFileSync('examples/srs-request.json','utf8'))}];
 const r=decompose(t,randomUUID),v=assemble(r,2);expect(v.examples[0].request.version).toBe(2);expect(r.payload.examples[0].request.version).toBe(1);expect(validateTemplate(v).ok).toBe(true);
});
