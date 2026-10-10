import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
const fixture=()=>JSON.parse(readFileSync('examples/cell-repeat-template.json','utf8'));
it('round trips model10 image item parents and repeat declarations',()=>{const t=fixture(),r=decompose(t,randomUUID);expect(()=>checkRecord(r)).not.toThrow();expect(assemble(r,1)).toEqual(t);const photos=r.variables.filter(v=>v.key==='photo');expect(photos).toHaveLength(2);expect(photos.every(v=>v.typeId===110004&&v.parentId)).toBe(true);});
it('rejects old model child images and invalid parent ownership',()=>{
 const r=decompose(fixture(),randomUUID);r.payload.nodeModelVersion=9;expect(()=>checkRecord(r)).toThrow();
 const s=decompose(fixture(),randomUUID),photo=s.variables.find(v=>v.key==='photo');photo.parentId=s.variables.find(v=>v.typeId===110003&&v.schemaId!==photo.schemaId).id;expect(()=>checkRecord(s)).toThrow();
 const n=decompose(fixture(),randomUUID);n.variables.find(v=>v.key==='photo').typeId=110003;expect(()=>checkRecord(n)).toThrow();
});
