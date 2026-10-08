import {beforeAll,afterAll,it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const source=JSON.parse(readFileSync('examples/srs-template.json','utf8'));
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>ok(await migrate(pool)));afterAll(()=>pool.end());
it('edits current, clones independently, retries and preserves old versions',async()=>{
 const t={...source,templateId:'tpl-current',docKey:'current'};
 let r=ok(await importCurrent(pool,JSON.stringify(t)));
 const a=ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'first'}));expect(a.version).toBe(1);
 const v=r.variables.find(v=>v.key==='projectName'),id=v.id;v.payload.label='new name';
 r=ok(await saveCurrent(pool,r,r.revision));expect(r.variables.find(v=>v.id===id)).toBeDefined();
 expect(ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'first'})).versionId).toBe(a.versionId);
 const pair=await Promise.all(['second','third'].map(requestId=>publishCurrent(pool,{templateId:t.templateId,requestId})));expect(pair.map(x=>ok(x).version).sort()).toEqual([2,3]);
 const old=ok(await loadTemplate(pool,'current',1));expect(old.template.definition.globalSchema.fields.projectName.label).toBe(source.globalSchema.fields.projectName.label);
 const root=r.variables.find(v=>v.key==='projectName');r.variables=r.variables.filter(v=>v.id!==root.id);ok(await saveCurrent(pool,r,r.revision));
 expect((await publishCurrent(pool,{templateId:t.templateId,requestId:'bad'})).ok).toBe(false);
 expect(ok(await loadTemplate(pool,'current',1)).versionId).toBe(a.versionId);
 expect((await saveCurrent(pool,r,r.revision)).ok).toBe(false);
 const rows=await pool.query('SELECT id FROM variable_versions');expect(rows.rows.some(x=>x.id===id)).toBe(false);
});
it('creates current and master rows with timestamps, not a published version',async()=>{
 const t={...source,templateId:'tpl-draftonly',docKey:'draftonly'};const r=ok(await importCurrent(pool,JSON.stringify(t)));
 expect(ok(await loadCurrent(pool,t.templateId))).toEqual(r);expect((await loadTemplate(pool,t.docKey)).ok).toBe(false);
 expect((await pool.query('SELECT id,code,created_at FROM variable_types ORDER BY id')).rows.map(r=>[r.id,r.code,!!r.created_at])).toEqual([[110001,'string',true],[110002,'object',true],[110003,'array',true],[110004,'image',true]]);
});
it('rolls back all clone rows on failure and retries the same token',async()=>{
 const t={...source,templateId:'tpl-failclone',docKey:'failclone'};ok(await importCurrent(pool,JSON.stringify(t)));
 await pool.query("ALTER TABLE publication_receipts ADD CONSTRAINT fixture_fail_receipt CHECK (request_id <> 'fail-token')");
 try{expect((await publishCurrent(pool,{templateId:t.templateId,requestId:'fail-token'})).ok).toBe(false);expect((await pool.query('SELECT id FROM template_versions WHERE template_id=$1',[t.templateId])).rowCount).toBe(0);}finally{await pool.query('ALTER TABLE publication_receipts DROP CONSTRAINT fixture_fail_receipt');}
 expect(ok(await publishCurrent(pool,{templateId:t.templateId,requestId:'fail-token'})).version).toBe(1);
});
it('serializes current mutations with publication and rejects cross-owner IDs',async()=>{
 const t={...source,templateId:'tpl-locked',docKey:'locked'};const r=ok(await importCurrent(pool,JSON.stringify(t)));
 const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT id FROM templates WHERE id=$1 FOR UPDATE',[t.templateId]);
 let done=false;const pending=publishCurrent(pool,{templateId:t.templateId,requestId:'wait'}).then(v=>{done=true;return v;});
 await new Promise(resolve=>setTimeout(resolve,80));expect(done).toBe(false);await client.query('COMMIT');expect(ok(await pending).version).toBe(1);
 }finally{client.release();}
 const v=r.variables[0];v.schemaId=r.schemas.find(s=>s.id!==v.schemaId).id;expect((await saveCurrent(pool,r,r.revision)).ok).toBe(false);
});
it('enforces master references and version immutability in SQL',async()=>{
 await expect(pool.query('DELETE FROM variable_types WHERE id=110001')).rejects.toMatchObject({code:'23503'});
 await expect(pool.query("UPDATE variable_types SET code='number' WHERE id=110001")).rejects.toMatchObject({code:'55000'});
 const s=(await pool.query('SELECT id FROM variable_versions LIMIT 1')).rows[0];await expect(pool.query('DELETE FROM variable_versions WHERE id=$1',[s.id])).rejects.toMatchObject({code:'55000'});
});
it('uses v7 version IDs and reports a conflicting draft identity',async()=>{
 const t={...source,templateId:'tpl-v7',docKey:'v7'};
 const {registerTemplate}=await import('../dist/templates/registry.js');
 expect(ok(await registerTemplate(pool,JSON.stringify(t))).versionId[14]).toBe('7');
 expect(await importCurrent(pool,JSON.stringify({...t,templateId:'different-v7'}))).toMatchObject({ok:false,issues:[{code:'TEMPLATE_IDENTITY_CONFLICT'}]});
});
it('rejects duplicate root names and foreign schema parents in SQL',async()=>{
 const t={...source,templateId:'tpl-sql-guards',docKey:'sql-guards'},r=ok(await importCurrent(pool,JSON.stringify(t)));
 const v=r.variables.find(v=>v.parentId===null),other=r.variables.find(x=>x.schemaId!==v.schemaId);
 await expect(pool.query('INSERT INTO variables(id,schema_id,parent_id,key,type_id,position,payload) VALUES(uuidv7(),$1,NULL,$2,$3,0,$4)',[v.schemaId,v.key,v.typeId,JSON.stringify(v.payload)])).rejects.toMatchObject({code:'23505'});
 await expect(pool.query('UPDATE variables SET parent_id=$1 WHERE id=$2',[other.id,v.id])).rejects.toMatchObject({code:'23503'});
});
it('reports conflicting draft key as an identity conflict',async()=>{
 const t={...source,templateId:'tpl-conflict-draft',docKey:'conflict-draft'};ok(await importCurrent(pool,JSON.stringify(t)));
 expect(await importCurrent(pool,JSON.stringify({...t,templateId:'different-conflict'}))).toMatchObject({ok:false,issues:[{code:'TEMPLATE_IDENTITY_CONFLICT'}]});
});
it('serializes actual save and register with publish',async()=>{
 const {registerTemplate}=await import('../dist/templates/registry.js');
 const t={...source,templateId:'tpl-interleave',docKey:'interleave'};const r=ok(await importCurrent(pool,JSON.stringify(t)));r.payload.name='Edited';
 const results=await Promise.all([saveCurrent(pool,r,r.revision),publishCurrent(pool,{templateId:t.templateId,requestId:'concurrent-save'})]);results.forEach(ok);
 const first=ok(await loadTemplate(pool,t.docKey,1));expect([source.name,'Edited']).toContain(first.template.definition.name);
 const t2={...t,version:2};const pair=await Promise.all([registerTemplate(pool,JSON.stringify(t2)),publishCurrent(pool,{templateId:t.templateId,requestId:'concurrent-register'})]);
 expect(pair.filter(x=>x.ok).length).toBeGreaterThanOrEqual(1);
 const versions=(await pool.query('SELECT version FROM template_versions WHERE template_id=$1 ORDER BY version',[t.templateId])).rows.map(x=>x.version);expect(new Set(versions).size).toBe(versions.length);
 for(const version of versions)ok(await loadTemplate(pool,t.docKey,version));
});
