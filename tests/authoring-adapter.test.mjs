import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {decompose} from '../dist/templates/assembly.js';
const api=await import('../dist/authoring/adapter.js').catch(()=>({}));
const template=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));
it('preserves normalized identities when changing data labels and adding variables',()=>{
 expect(api.reconcileDefinition).toBeTypeOf('function');
 let n=0;const old=decompose(template,()=>`id-${++n}`);old.revision=3;
 const next=structuredClone(template);next.name='Changed';next.globalSchema.fields.note={type:'string'};
 const updated=api.reconcileDefinition(next,old);
 expect(updated.sections.map(x=>x.id)).toEqual(old.sections.map(x=>x.id));
 expect(updated.formats.map(x=>x.id)).toEqual(old.formats.map(x=>x.id));
 expect(updated.schemas.map(x=>x.id)).toEqual(old.schemas.map(x=>x.id));
 for(const v of old.variables)expect(updated.variables.find(x=>x.id===v.id)).toBeDefined();
 expect(updated.variables).toHaveLength(old.variables.length+1);
});

it('rejects ambiguous group rename rather than reallocating the subtree',()=>{
 const before=structuredClone(template);before.globalSchema.fields.oldGroup={type:'array',items:{type:'object',fields:{label:{type:'string'}}}};
 let n=0;const stored=decompose(before,()=> 'group-'+(++n));const after=structuredClone(before);
 after.globalSchema.fields.newGroup=after.globalSchema.fields.oldGroup;delete after.globalSchema.fields.oldGroup;
 expect(()=>api.reconcileDefinition(after,stored)).toThrow('rename');
});
