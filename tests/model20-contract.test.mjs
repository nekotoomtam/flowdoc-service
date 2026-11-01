import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {templateContract} from '../dist/templates/contract.js';
import {model20Fixture} from './helpers/model20.mjs';
it('describes model20 definition selection, instance identity and caller-controlled ordering',()=>{
 const t=model20Fixture(),v=validateTemplate(t);expect(v.ok,JSON.stringify(v)).toBe(true);const before=structuredClone(t),c=templateContract(t);
 expect(c.nodeModelVersion).toBe(20);expect(c.sections.map(s=>[s.id,s.sectionKey])).toEqual(t.sections.map(s=>[s.id,s.sectionKey]));
 expect(c.assembly).toEqual({input:'array-by-section-key',instanceKey:'required-unique-per-request',order:'request',reuseDefinitions:true});
 expect(c.sections[0].header).toEqual(t.sections[0].header.inputSchema);expect(c.sections[0].footer).toEqual(t.sections[0].footer.inputSchema);expect(c.areaFormats.meeting.sizing).toEqual(t.areaFormats.meeting.sizing);
 expect(c.examples[0].request.sections.map(s=>[s.sectionKey,s.instanceKey])).toEqual([['A','first'],['B','middle'],['A','last']]);
 expect(prepareGeneration(v.value,c.examples[0].request).ok).toBe(true);expect(c).not.toHaveProperty('prepared');expect(c).not.toHaveProperty('normalizationVersion');expect(t).toEqual(before);
});
// Golden hashes captured from the unchanged pinned Service image's contract function.
it.each([
 ['examples/area-document-template.json','18d4acfba37de8f673308906a1f8fdbf66b67623630e278063bb588446679b1c'],
 ['tests/fixtures/format-sizing/template.json','db74d4ed82c33316a6feedcab8204c12073075382e51eb7d5cda238a424d5168']
])('keeps the exact model18/19 JSON contract bytes: %s',(path,hash)=>{
 const t=JSON.parse(readFileSync(path,'utf8'));expect(createHash('sha256').update(JSON.stringify(templateContract(t))).digest('hex')).toBe(hash);
});
