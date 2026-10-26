import {it,expect,beforeAll,beforeEach,afterAll} from 'vitest';
import {fixture,template,response,artifact,auth} from './taskDocxFixture.mjs';
const t=template(),f=t.areaFormats.item.fragment,pt=value=>({value,unit:'pt'});
delete f.nodes.photo;
f.nodes.heading={id:'heading',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'headleaf',type:'text',text:'CONTAINER'}]};
f.nodes.table={id:'table',type:'table',props:{headerRowCount:1,repeatHeaderRows:true,borderStyle:'thickThinWideGap',borderWidth:pt(.35)},columns:[{width:pt(250)}],rowIds:['header','row']};
f.nodes.header={id:'header',type:'table-row',props:{allowBreak:false},cellIds:['hc']};f.nodes.row={id:'row',type:'table-row',props:{allowBreak:true},cellIds:['bc']};
f.nodes.hc={id:'hc',type:'table-cell',props:{},childIds:['heading']};f.nodes.bc={id:'bc',type:'table-cell',props:{},childIds:['text']};f.rootIds=['table'];
const fx=fixture(t);beforeAll(()=>fx.setup());beforeEach(()=>fx.reset());afterAll(()=>fx.close());
it.each(['pdf','docx'])('sends B %s through Service normalization and child rendering with the pinned Core',async format=>{
 const id=await fx.task(format,0,false,'X'),out=response(),result=await fx.manager.execute({authorization:auth,taskId:id,response:out});expect(result.status).toBe('succeeded');
 const file=artifact(out.parts),row=(await fx.pool.query('SELECT normalization_summary FROM tasks WHERE id=$1',[id])).rows[0];
 expect(row.normalization_summary.coreVersion).toBe('0.5.1');expect(file.bytes.length).toBeGreaterThan(1000);
 if(format==='pdf'){
  expect(file.bytes.subarray(0,5).toString()).toBe('%PDF-');const content=file.bytes.toString('latin1');expect(content).toContain('[1.4 4.2] 0 d');expect(content).toContain('0.21 w');expect(content).toContain('0.07 w');
 }else expect(file.bytes.subarray(0,2).toString()).toBe('PK');
},60000);
