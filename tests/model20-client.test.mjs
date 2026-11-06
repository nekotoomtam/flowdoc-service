import {it,expect} from 'vitest';
import {bindImages} from '../examples/api-client/client.mjs';
import {templateContract} from '../dist/templates/contract.js';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {model20Fixture} from './helpers/model20.mjs';
it('binds real model20 typed image slots by definition key across reordered/repeated instances',()=>{
 const t=model20Fixture({rich:true});t.globalSchema.fields.photo={type:'image',required:true};const validated=validateTemplate(t);expect(validated.ok,JSON.stringify(validated)).toBe(true);
 const entry=(instanceKey,photo)=>({sectionKey:'A',instanceKey,data:{content:[{format:'meeting',data:{photo,companies:[{name:'Group',members:[{name:'Member'}]}]}}]},header:{note:'HEADER'},footer:{note:'FOOTER'}});
 const q={docKey:t.docKey,data:{photo:'global'},sections:[{sectionKey:'B',instanceKey:'middle',data:{title:'global'}},entry('last','last'),entry('first','first')]},before=structuredClone(q);
 const ids=new Map(['global','last','first'].map((k,i)=>[k,`20000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
 const bound=bindImages(q,templateContract(t),ids);expect(q).toEqual(before);expect(bound.data.photo).toBe(ids.get('global'));expect(bound.sections[0].data.title).toBe('global');
 expect(bound.sections[1].data.content[0].data.photo).toBe(ids.get('last'));expect(bound.sections[2].data.content[0].data.photo).toBe(ids.get('first'));expect(prepareGeneration(validated.value,bound).ok).toBe(true);
});
