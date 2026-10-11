import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
it('round trips line and table colors and freezes published versions',async()=>{
 const t=JSON.parse(readFileSync('examples/page-numbering-template.json','utf8'));t.templateId=t.docKey='line-colors';
 const pt=value=>({value,unit:'pt'}),rule={id:'rule',type:'line',props:{color:'123456',thickness:pt(1),spaceAfter:pt(3)}};
 const f=t.sections[0].source.fragment;f.rootIds.push('rule','table');f.nodes.rule=rule;
 Object.assign(f.nodes,{table:{id:'table',type:'table',props:{headerRowCount:1,repeatHeaderRows:true,headerFillColor:'EEEEEE',borderColor:'333333'},columns:[{width:pt(100)}],rowIds:['row']},row:{id:'row',type:'table-row',props:{allowBreak:true},cellIds:['cell']},cell:{id:'cell',type:'table-cell',props:{fillColor:'DDEEFF'},childIds:['label']},label:{id:'label',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'txt',type:'text',text:'COLOR'}]}});
 t.sections[0].header.fragment.nodes.rule=structuredClone(rule);t.sections[0].header.fragment.rootIds.push('rule');
 ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'}));
 const first=ok(await loadTemplate(db.pool,t.docKey,1));expect(first.template.definition.sections[0].source.fragment).toEqual(f);
 const c=ok(await loadCurrent(db.pool,t.templateId));c.sections[0].payload.source.fragment.nodes.cell.props.fillColor='FFFFFF';
 ok(await saveCurrent(db.pool,c,c.revision));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'second'}));
 expect(ok(await loadTemplate(db.pool,t.docKey,1)).template).toEqual(first.template);
 expect(ok(await loadTemplate(db.pool,t.docKey,2)).template.definition.sections[0].source.fragment.nodes.cell.props.fillColor).toBe('FFFFFF');
});

