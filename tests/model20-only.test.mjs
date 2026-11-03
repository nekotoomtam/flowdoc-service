import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,checkRecord,assemble} from '../dist/templates/assembly.js';
import {templateContract} from '../dist/templates/contract.js';
import {model20Fixture} from './helpers/model20.mjs';
for(const source of ['tests/fixtures/legacy-rejection/18-template.json','tests/fixtures/legacy-rejection/19-template.json']){
 const legacy=()=>JSON.parse(readFileSync(source,'utf8'));
 it('rejects legacy persistence input '+source,()=>{expect(()=>decompose(legacy(),randomUUID)).toThrow();});
 it('rejects legacy contract '+source,()=>{expect(()=>templateContract(legacy())).toThrow();});
 it('rejects legacy stored record '+source,()=>{const r=decompose(model20Fixture(),randomUUID);r.payload.nodeModelVersion=legacy().nodeModelVersion;expect(()=>checkRecord(r)).toThrow();});
}
it('retains explicit20 definition storage and request assembly without mutation',()=>{
 const t=model20Fixture(),before=structuredClone(t),r=decompose(t,randomUUID);expect(()=>checkRecord(r)).not.toThrow();expect(assemble(r,1)).toEqual(t);expect(t).toEqual(before);expect(templateContract(t)).toMatchObject({nodeModelVersion:20,assembly:{order:'request',reuseDefinitions:true}});
});
