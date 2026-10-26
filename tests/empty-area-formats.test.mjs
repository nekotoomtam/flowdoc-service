import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {validateTemplate} from '@flowdoc/core';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
import {migrate} from '../dist/db/migrate.js';
import {isolatedDatabase} from './isolatedDatabase.mjs';
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
function definition(model,present=true){
 const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.templateId=t.docKey='empty-formats-'+model;t.nodeModelVersion=model;t.examples=[];t.globalSchema={type:'object',fields:{}};t.areaFormats={};t.defaultFileName='Empty format report';
 const s={id:model===18?'main':'10000000-0000-4000-8000-000000000011',label:'Report',...(model===18?{key:'main',formats:{}}:{nameBase:'Report'}),inputSchema:{type:'object',fields:{}},source:{kind:'authored',repeats:[],fragment:{rootIds:['text'],nodes:{text:{id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'text',text:'No Area needed'}]}}}}};t.sections=[s];if(!present)delete t.areaFormats;return ok(validateTemplate(t));
}
for(const model of [18,19])for(const present of [false,true])it('preserves model'+model+' empty-format presence='+present+' and its exact fingerprint',()=>{
 const valid=definition(model,present),record=decompose(valid.definition,randomUUID),result=ok(validateTemplate(assemble(record,valid.definition.version)));
 expect(Object.hasOwn(result.definition,'areaFormats')).toBe(present);expect(result.definition).toEqual(valid.definition);expect(result.fingerprint).toBe(valid.fingerprint);expect(record.formats).toHaveLength(0);
});
it('does not permit unowned nonempty Area definitions in the root payload',()=>{
 const r=decompose(definition(19).definition,randomUUID);r.payload.areaFormats={injected:{key:'bad'}};expect(()=>checkRecord(r)).toThrow();
});
const db=isolatedDatabase();beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
it.each([18,19])('registers and reloads model%d empty areaFormats without changing immutable JSON',async model=>{
 const valid=definition(model),registered=ok(await registerTemplate(db.pool,JSON.stringify(valid.definition))),loaded=ok(await loadTemplate(db.pool,valid.definition.docKey,valid.definition.version));
 expect(loaded.template.definition).toEqual(valid.definition);expect(loaded.template.fingerprint).toBe(valid.fingerprint);
 const stored=(await db.pool.query('SELECT definition_json,fingerprint FROM template_versions WHERE id=$1',[registered.versionId])).rows[0];expect(stored).toEqual({definition_json:valid.definition,fingerprint:valid.fingerprint});
 expect((await db.pool.query('SELECT count(*) FROM format_versions WHERE template_version_id=$1',[registered.versionId])).rows[0].count).toBe('0');
});
