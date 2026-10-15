import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
import {templateContract} from '../dist/templates/contract.js';
const fixture=()=>JSON.parse(readFileSync('examples/area-document-template.json','utf8'));
it('preserves the Area18 envelope and named-area contract through relational assembly',()=>{
 const t=fixture(),r=decompose(t,randomUUID);
 expect(assemble(r,1)).toEqual(t);
 expect(templateContract(t)).toMatchObject({sections:{main:{formats:{},inputSchema:t.sections[0].inputSchema}},areaFormats:{meeting:{ownerAreaId:'main-details'}}});
});
it.each(Array.from({length:14},(_,i)=>i+4))('rejects unsupported model %s at decomposition, persisted-record and contract boundaries',version=>{
 const t=fixture(),r=decompose(t,randomUUID);t.nodeModelVersion=version;r.payload.nodeModelVersion=version;
 expect(()=>decompose(t,randomUUID)).toThrow();expect(()=>checkRecord(r)).toThrow();expect(()=>assemble(r,1)).toThrow();expect(()=>templateContract(t)).toThrow();
});
