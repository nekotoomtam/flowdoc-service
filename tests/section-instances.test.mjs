import {it,expect} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {validateTemplate} from '@flowdoc/core';
import {decompose} from '../dist/templates/assembly.js';
it('does not ship the retired model19 instance executor',()=>{expect(existsSync('dist/authoring/sectionInstances.js')).toBe(false);expect(existsSync('dist/authoring/sectionOperations.js')).toBe(false);});
it.each([18,19])('rejects genuine legacy model%s before normalized persistence',model=>{const t=JSON.parse(readFileSync('tests/fixtures/legacy-rejection/'+model+'-template.json'));expect(t.nodeModelVersion).toBe(model);expect(validateTemplate(t).ok).toBe(false);expect(()=>decompose(t,()=>{throw Error('identity allocation must not run')})).toThrow('Invalid current record');});
