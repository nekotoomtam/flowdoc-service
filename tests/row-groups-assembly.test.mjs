import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateTemplate} from '@flowdoc/core';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
import {templateContract} from '../dist/templates/contract.js';
const fixture=()=>JSON.parse(readFileSync('examples/row-groups-template.json','utf8'));
it('round trips two array levels and rowGroups with independent variable IDs',()=>{
 const t=fixture(),r=decompose(t,randomUUID);expect(assemble(r,1)).toEqual(t);expect(validateTemplate(assemble(r,1)).ok).toBe(true);
 const outer=r.variables.find(v=>v.key==='companies'),inner=r.variables.find(v=>v.key==='members');expect(inner.parentId).toBe(outer.id);expect(r.variables.filter(v=>v.parentId===inner.id).map(v=>v.key)).toEqual(['name']);
 const c=templateContract(assemble(r,1));expect(c.areaFormats.meeting.inputSchema.fields.companies.items.fields.members.type).toBe('array');expect(JSON.stringify(c)).not.toContain('rowTemplateIds');
});
it('rejects third arrays, cycles, cross-schema parents and old-version nested records',()=>{
 const base=decompose(fixture(),randomUUID),inner=base.variables.find(v=>v.key==='members'),leaf=base.variables.find(v=>v.parentId===inner.id);
 for(const edit of [r=>r.payload.nodeModelVersion=16,r=>r.variables.find(v=>v.id===leaf.id).typeId=110003,r=>r.variables.find(v=>v.id===inner.id).parentId=inner.id,r=>r.variables.find(v=>v.id===inner.id).schemaId=r.schemas.find(s=>s.id!==inner.schemaId).id]){const r=structuredClone(base);edit(r);expect(()=>checkRecord(r)).toThrow();}
});
