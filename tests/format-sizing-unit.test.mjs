import {it,expect} from 'vitest';
import {buildAreaContract} from '../dist/templates/areaContract.js';
import {failJob} from '../dist/jobs/repository.js';
import {cloneInstances} from '../dist/authoring/sectionInstances.js';
import {readFileSync} from 'node:fs';
const warning={code:'FORMAT_CONTENT_OMITTED',path:'areaFormats.panel.sizing',message:'Partial',action:'skipped',sectionId:'section',formatOmission:{version:1,areaId:'area',areaEntryIndex:0,areaFormatId:'panel',format:'panel',reason:'height-limit',pending:[{kind:'text',nodeId:'n',sourceNodeId:'text',lineIndex:2}]}};
it('describes explicit sizing in public Area contracts without adding omitted sizing',()=>{
 const t={areaFormats:{panel:{ownerAreaId:'a',key:'panel',sizing:{mode:'fixed',height:{value:100,unit:'pt'}},inputSchema:{type:'object',fields:{}}},old:{ownerAreaId:'a',key:'old',inputSchema:{type:'object',fields:{}}}}};
 const contract=buildAreaContract(t);expect(contract.panel.sizing).toEqual(t.areaFormats.panel.sizing);expect(contract.old).not.toHaveProperty('sizing');
});
it('persists render warnings with failure status and keeps old failure calls valid',async()=>{
 const calls=[],pool={async query(sql,args){calls.push({sql,args});return {rowCount:1};}};
 expect(await failJob(pool,'job',[],[warning])).toBe(true);
 expect(calls[0].sql).toContain('warnings_json');expect(calls[0].args).toContain(JSON.stringify([warning]));
 calls.length=0;expect(await failJob(pool,'old',[])).toBe(true);expect(calls[0].args).toContain('[]');
});
it('clones sizing by value while replacing Section and Area identities',()=>{
 const t=JSON.parse(readFileSync('tests/fixtures/area-cover/template.json'));const f=Object.values(t.areaFormats)[0];f.sizing={mode:'fixed',height:{value:120,unit:'pt'}};
 const before=structuredClone(t),copy=cloneInstances(t,{templateId:'copy',docKey:'copy',name:'copy'},1).definition;
 expect(Object.values(copy.areaFormats).find(v=>v.key===f.key).sizing).toEqual(f.sizing);expect(copy.sections[0].id).not.toBe(t.sections[0].id);expect(t).toEqual(before);
});
