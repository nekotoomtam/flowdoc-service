import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
const fixture=()=>JSON.parse(readFileSync('examples/area-template.json','utf8'));
it('roundtrips owned subformats with independent row and authored identities',()=>{const t=fixture(),r=decompose(t,randomUUID);expect(assemble(r,1)).toEqual(t);const a=r.variables.find(v=>v.typeId===110006);expect(r.formats.filter(f=>f.ownerAreaVariableId===a.id)).toHaveLength(2);expect(r.formats.find(f=>f.sourceDefinitionId==='format-002')).toBeDefined();});
it('rejects dangling or wrong type owners',()=>{const r=decompose(fixture(),randomUUID);const f=r.formats.find(f=>f.ownerAreaVariableId);f.ownerAreaVariableId=randomUUID();expect(()=>checkRecord(r)).toThrow();});
