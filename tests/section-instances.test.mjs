import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {assemble,decompose} from '../dist/templates/assembly.js';
const api=await import('../dist/authoring/sectionInstances.js').catch(()=>({}));
export const uid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function seed19(){
 const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));
 t.nodeModelVersion=19;t.examples=[];t.globalSchema={type:'object',fields:{}};t.sections=t.sections.slice(0,1);t.areaFormats={};
 const s=t.sections[0];s.id=uid(1);delete s.key;delete s.formats;s.label='SRS1';s.nameBase='SRS';delete s.role;
 s.inputSchema={type:'object',fields:{name:{type:'string',required:true},details:{type:'area',areaId:uid(21)}}};
 s.source={kind:'authored',repeats:[],fragment:{rootIds:['text','area'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:Object.keys(t.styles)[0]},children:[{id:'v',type:'field-ref',scope:'section',key:'name'}]},area:{id:'area',type:'area',props:{areaId:uid(21)}}}}};
 for(const k of ['header','footer'])s[k]={inputSchema:{type:'object',fields:{name:{type:'string',required:true}}},baseTextStyleId:Object.keys(t.styles)[0],fragment:{rootIds:['text'],nodes:{text:{...structuredClone(s.source.fragment.nodes.text),children:[{id:'v',type:'field-ref',scope:k,key:'name'}]}}}};
 t.areaFormats[uid(31)]={key:'paragraph',ownerAreaId:uid(21),inputSchema:{type:'object',fields:{text:{type:'string',required:true}}},fragment:{rootIds:['p'],nodes:{p:{id:'p',type:'text-block',role:{role:'paragraph'},props:{textStyleId:Object.keys(t.styles)[0]},children:[{id:'v',type:'field-ref',scope:'local',key:'text'}]}}},repeats:[]};return t;
}
it('round trips model19 through normalized storage without inventing public key/formats',()=>{const t=seed19();let n=100;const d=assemble(decompose(t,()=>uid(n++)),1);expect(d).toEqual(t);expect(validateTemplate(d).ok).toBe(true);});
it('copies Section, Area, Format, style and layout identities while keeping external resources',()=>{
 expect(api.importSections).toBeTypeOf('function');const t=seed19(),before=structuredClone(t),r=api.importSections(t,t,[uid(1)],1,null);
 expect(t).toEqual(before);expect(r.definition.sections.map(s=>s.label)).toEqual(['SRS1','SRS2']);
 const copy=r.definition.sections[1];expect(copy.id).not.toBe(uid(1));expect(copy.origin).toEqual({templateId:t.templateId,revision:1,sectionId:uid(1)});
 expect(copy.inputSchema.fields.details.areaId).not.toBe(uid(21));expect(copy.pageLayoutId).not.toBe(r.definition.sections[0].pageLayoutId??t.book.defaultPageLayoutId);
 const v=validateTemplate(r.definition);expect(v.ok,JSON.stringify(v)).toBe(true);if(!v.ok)return;
 const entry=(id,name)=>({id,data:{name,details:[{format:'paragraph',data:{text:name+' local'}}]},header:{name:name+' head'},footer:{name:name+' foot'}});
 const p=prepareGeneration(v.value,{docKey:t.docKey,data:{},sections:[entry(copy.id,'Beta'),entry(uid(1),'Alpha')]});expect(p.ok,JSON.stringify(p)).toBe(true);if(!p.ok)return;
 const d=composeDocument(v.value,p.value);expect(d.ok,JSON.stringify(d)).toBe(true);if(!d.ok)return;
 const texts=Object.values(d.value.nodes).filter(n=>n.type==='text-block').flatMap(n=>n.children.filter(c=>c.type==='text').map(c=>c.text));
 expect(texts).toEqual(['Alpha','Alpha local','Beta','Beta local']);
 expect(d.value.sections.map(s=>s.header.nodes[s.header.rootIds[0]].children[0].text)).toEqual(['Alpha head','Beta head']);
 expect(d.value.sections.map(s=>s.footer.nodes[s.footer.rootIds[0]].children[0].text)).toEqual(['Alpha foot','Beta foot']);
});
it('promotes only imported globals, requiring explicit rename on collision',()=>{
 expect(api.importSections).toBeTypeOf('function');const source=seed19(),target=seed19();source.globalSchema.fields.name={type:'string',required:true};source.sections[0].source.fragment.nodes.text.children[0].scope='global';
 expect(()=>api.importSections(target,source,[uid(1)],2,null)).toThrow('IMPORT_BINDING_COLLISION');
 const r=api.importSections(target,source,[uid(1)],2,null,{[uid(1)]:{name:'sourceName'}}),s=r.definition.sections[1];
 expect(s.inputSchema.fields.sourceName).toEqual({type:'string',required:true});expect(s.source.fragment.nodes.text.children[0]).toMatchObject({scope:'section',key:'sourceName'});expect(r.definition.globalSchema.fields).toEqual({});
});
it('rejects external Section dependencies and invalid selections atomically',()=>{
 expect(api.importSections).toBeTypeOf('function');const t=seed19();t.sections[0].source.fragment.nodes.text.children.push({id:'link',type:'reference',text:'other',target:'x',targetSectionId:uid(9)});
 expect(()=>api.importSections(t,t,[uid(1)],1,null)).toThrow('SECTION_DEPENDENCY_OUTSIDE_SELECTION');expect(t.sections).toHaveLength(1);
 for(const selected of [[],[uid(3)],[uid(1),uid(1)]])expect(()=>api.importSections(seed19(),seed19(),selected,1,null)).toThrow();
});
