import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
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
// Historical contract goldens remain in Git and the frozen Service baseline.
it.each(['tests/fixtures/legacy-rejection/18-template.json','tests/fixtures/legacy-rejection/19-template.json'])('rejects the retired contract instead of advertising it: %s',path=>{
 const t=JSON.parse(readFileSync(path,'utf8'));expect(validateTemplate(t).ok).toBe(false);expect(()=>templateContract(t)).toThrow(expect.objectContaining({code:'INVALID_TEMPLATE',path:'nodeModelVersion'}));
});
