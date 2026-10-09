import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble} from '../dist/templates/assembly.js';
it('roundtrips link defaults and array item links through the master mapping',()=>{const t=JSON.parse(readFileSync('examples/links-template.json','utf8'));t.globalSchema.fields.rows={type:'array',items:{type:'object',fields:{link:{type:'link',default:{type:'url',value:'https://example.com'}}}}};const r=decompose(t,randomUUID);expect(r.variables.filter(v=>v.typeId===110005)).toHaveLength(2);expect(assemble(r,1)).toEqual(t);});
