import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
import {documentBaseline,setDocumentBaseline} from '../dist/templates/baseline.js';

const db=isolatedDatabase();
const fixture=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
const consumer={ownerKey:'lab',principalId:'receipts'};
const checked=result=>{expect(result.ok,JSON.stringify(result.issues)).toBe(true);return result.value;};
const resolve=async(identity,version)=>checked(await loadTemplate(db.pool,fixture.docKey,version,identity)).template.definition.version;
beforeAll(async()=>{await db.setup();checked(await migrate(db.pool));});
afterAll(()=>db.close());

it('resolves a baseline only for the matching consumer and rejects stale changes',async()=>{
 const publish=async version=>checked(await registerTemplate(db.pool,JSON.stringify({...fixture,version})));
 const switchTo=(pinned,latest,target)=>setDocumentBaseline(db.pool,fixture.templateId,consumer,{pinned,latest},target);
 await publish(5);
 expect(await switchTo(null,5,5)).toBe('updated');
 await publish(6);
 expect(await resolve(consumer)).toBe(5);
 expect(await resolve(consumer,6)).toBe(6);
 expect(await resolve({...consumer,principalId:'another'})).toBe(6);
 expect(await resolve({...consumer,ownerKey:'another'})).toBe(6);
 expect(await resolve(undefined)).toBe(6);
 expect(await switchTo(null,5,6)).toBe('stale');
 expect(await switchTo(5,6,99)).toBe('invalid');
 expect(await switchTo(5,6,6)).toBe('updated');
 expect(await resolve(consumer)).toBe(6);
 expect(await switchTo(6,6,5)).toBe('updated');
 expect(await documentBaseline(db.pool,fixture.templateId,consumer)).toEqual({pinned:5,versions:[6,5]});
});
