import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
import {reconcileDefinition} from '../dist/authoring/adapter.js';
import {model20Fixture} from './helpers/model20.mjs';
const valid=t=>{const v=validateTemplate(t);expect(v.ok,JSON.stringify(v)).toBe(true);return v.value;};
it.each([1,2])('roundtrips model20 schema%s without duplicating definition keys or losing owned content',schemaVersion=>{
 const t=model20Fixture({rich:true,schemaVersion}),before=structuredClone(t),v=valid(t),r=decompose(t,randomUUID);
 expect(()=>checkRecord(r)).not.toThrow();expect(r.sections.map(s=>s.key)).toEqual(['A','B']);
 expect(r.sections.map(s=>s.sourceDefinitionId)).toEqual(t.sections.map(s=>s.id));
 expect(r.sections.every(s=>!Object.hasOwn(s.payload,'sectionKey')&&!Object.hasOwn(s.payload,'inputSchema'))).toBe(true);
 const restored=assemble(r,t.version);expect(restored).toEqual(t);expect(valid(restored).fingerprint).toBe(v.fingerprint);expect(t).toEqual(before);
});
it('keeps logical storage identities through definition reorder and sectionKey rename',()=>{
 const t=model20Fixture(),r=reconcileDefinition(t);r.revision=7;const original=structuredClone(r),d=structuredClone(t);d.examples=[];d.sections.reverse();d.sections[1].sectionKey='Renamed';valid(d);
 const next=reconcileDefinition(d,r);expect(next.revision).toBe(7);
 expect(new Map(next.sections.map(s=>[s.sourceDefinitionId,s.id]))).toEqual(new Map(r.sections.map(s=>[s.sourceDefinitionId,s.id])));
 expect(next.schemas.map(s=>s.id).sort()).toEqual(r.schemas.map(s=>s.id).sort());expect(next.variables.map(s=>s.id).sort()).toEqual(r.variables.map(s=>s.id).sort());expect(next.formats.map(s=>s.id).sort()).toEqual(r.formats.map(s=>s.id).sort());
 expect(assemble(next,1)).toEqual(d);expect(r).toEqual(original);
});
it('rejects ambiguous duplicated model20 key metadata and broken section ownership',()=>{
 const seed=()=>decompose(model20Fixture(),randomUUID);
 const duplicate=seed();duplicate.sections[0].payload.sectionKey='Alias';expect(()=>checkRecord(duplicate)).toThrow();
 const key=seed();key.sections[1].key=key.sections[0].key;expect(()=>checkRecord(key)).toThrow();
 const source=seed();source.sections[1].sourceDefinitionId=source.sections[0].sourceDefinitionId;expect(()=>checkRecord(source)).toThrow();
 const owner=seed(),schema=owner.schemas.find(s=>s.scope==='format');schema.sectionId=owner.sections[1].id;expect(()=>checkRecord(owner)).toThrow();
});
it('preserves an explicitly empty areaFormats map and publication example version binding',()=>{
 const t=model20Fixture();t.sections=t.sections.slice(1);t.areaFormats={};t.examples[0].request.sections=t.examples[0].request.sections.slice(1,2);valid(t);
 const r=decompose(t,randomUUID);expect(assemble(r,1)).toEqual(t);const next=assemble(r,2);expect(next.examples[0].request.version).toBe(2);expect(r.payload.examples[0].request.version).toBe(1);expect(valid(next).definition.version).toBe(2);
});
it('uses two saved definitions for three real Core request instances in A-B-A order',()=>{
 const t=model20Fixture(),r=decompose(t,randomUUID),v=valid(assemble(r,1)),p=prepareGeneration(v,t.examples[0].request);expect(p.ok,JSON.stringify(p)).toBe(true);
 const d=composeDocument(v,p.value);expect(d.ok,JSON.stringify(d)).toBe(true);expect(r.sections).toHaveLength(2);
 expect(d.value.sections.map(s=>[s.sectionKey,s.instanceKey,s.sectionId])).toEqual([['A','first','instance-first'],['B','middle','instance-middle'],['A','last','instance-last']]);
 for(const [key,value]of [['first','FIRST'],['middle','MIDDLE'],['last','LAST']]){
  const blocks=Object.values(d.value.nodes).filter(n=>n.type==='text-block'&&d.value.sourceMap[n.id]?.sectionId==='instance-'+key);
  expect(blocks.flatMap(n=>n.children.filter(c=>c.type==='text').map(c=>c.text))).toContain(value);
 }
 expect(d.value.sections[0].header.nodes[d.value.sections[0].header.rootIds[0]].children[0].text).toBe('FIRST header');
 expect(d.value.sections[2].footer.nodes[d.value.sections[2].footer.rootIds[0]].children[0].text).toBe('LAST footer');
});
it.each(['examples/area-document-template.json','tests/fixtures/format-sizing/template.json'])('preserves the unchanged old model envelope and fingerprint: %s',path=>{
 const t=JSON.parse(readFileSync(path,'utf8')),v=valid(t),restored=assemble(decompose(t,randomUUID),t.version);expect(restored).toEqual(t);expect(valid(restored).fingerprint).toBe(v.fingerprint);
});
