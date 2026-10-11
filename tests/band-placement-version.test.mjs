import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
it('preserves independent band placement without altering older snapshots',async()=>{
 const t=JSON.parse(readFileSync('examples/page-numbering-template.json','utf8'));t.templateId=t.docKey='band-placement';
 const pt=value=>({value,unit:'pt'}),placement={mode:'page',left:pt(0),right:pt(0),offset:pt(0)};
 t.sections[0].footer={baseTextStyleId:t.sections[0].header.baseTextStyleId,inputSchema:{type:'object',fields:{}},fragment:{rootIds:[],nodes:{}}};t.sections[0].header.placement=placement;t.sections[0].footer.placement={...placement,left:pt(12),offset:pt(8)};
 ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'page'}));
 const before=ok(await loadTemplate(db.pool,t.docKey,1));expect(before.template.definition.sections[0].header.placement).toEqual(placement);
 const c=ok(await loadCurrent(db.pool,t.templateId));expect(c.sections[0].payload.footer.placement.offset.value).toBe(8);delete c.sections[0].payload.header.placement;
 ok(await saveCurrent(db.pool,c,c.revision));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'legacy'}));
 expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(before.template);
 expect(ok(await loadTemplate(db.pool,t.docKey,2)).template.definition.sections[0].header.placement).toBeUndefined();
});

