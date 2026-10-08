import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
const unavailable={connect(){throw Error('must reject before DB');},query(){throw Error('must reject before DB');}};
it('rejects versions outside PostgreSQL integer range before storage',async()=>{
 const template=JSON.parse(readFileSync('examples/srs-template.json','utf8'));template.version=2147483648;
 expect(await registerTemplate(unavailable,JSON.stringify(template))).toMatchObject({ok:false,issues:[{code:'INVALID_TEMPLATE',path:'version'}]});
 expect(await loadTemplate(unavailable,template.docKey,2147483648)).toMatchObject({ok:false,issues:[{code:'INVALID_DATA'}]});
});
