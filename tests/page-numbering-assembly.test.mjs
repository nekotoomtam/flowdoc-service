import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateTemplate} from '@flowdoc/core';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
const fixture=()=>JSON.parse(readFileSync('examples/page-numbering-template.json','utf8'));
it('normalizes section rows and schemas without duplicate payload graphs',()=>{const t=fixture(),r=decompose(t,randomUUID);expect(r.sections).toHaveLength(3);expect(r.payload.sections).toBeUndefined();expect(r.sections[0].payload.inputSchema).toBeUndefined();expect(r.schemas.filter(s=>s.scope==='section')).toHaveLength(3);expect(assemble(r,1)).toEqual(t);expect(validateTemplate(assemble(r,1)).ok).toBe(true);});
it('rejects crossed schema ownership and duplicate keys only within their owner',()=>{const r=decompose(fixture(),randomUUID);const a=r.schemas.find(s=>s.scope==='section'),b=r.schemas.find(s=>s.scope==='header'&&s.sectionId!==a.sectionId);b.sectionId=a.sectionId;expect(()=>checkRecord(r)).toThrow();});
