import {it,expect} from 'vitest';
import * as api from '../dist/authoring/service.js';
it('identifies nested Section removals and reports truncation',()=>{
 expect(api.definitionDiff).toBeTypeOf('function');
 const before={sections:[{id:'main',inputSchema:{fields:{removed:{type:'string'},kept:{type:'string'}}}},{id:'deleted'}]};
 const after={sections:[{id:'main',inputSchema:{fields:{kept:{type:'string'}}}}]};
 expect(api.definitionDiff(before,after)).toMatchObject({diff:[{path:'sections.main.inputSchema.fields.removed',change:'removed'},{path:'sections.deleted',change:'removed'},{path:'sections.$order',change:'changed'}],diffTruncated:false});
 expect(api.definitionDiff({},Object.fromEntries(Array.from({length:201},(_,i)=>['v'+i,i])))).toMatchObject({diffTruncated:true});
});
