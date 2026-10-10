import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,loadCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
it('upgrades populated011 preserving model15 current and snapshots before accepting16',async()=>{
 const db=isolatedDatabase(),ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};await db.setup();try{
 await db.pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const name of readdirSync('migrations').filter(n=>/^(00[1-9]|01[01])_/.test(n)).sort()){const sql=readFileSync('migrations/'+name,'utf8');await db.pool.query(sql);await db.pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(sql).digest('hex')]);}
 const t=JSON.parse(readFileSync('examples/section-ownership-template.json','utf8'));ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'old'}));const before=ok(await loadCurrent(db.pool,t.templateId)),version=ok(await loadTemplate(db.pool,t.docKey,1));
 expect(ok(await migrate(db.pool)).applied).toEqual(['012_page_numbering.sql']);expect(ok(await loadCurrent(db.pool,t.templateId))).toEqual(before);expect(ok(await loadTemplate(db.pool,t.docKey,1))).toEqual(version);
 const n=JSON.parse(readFileSync('examples/page-numbering-template.json','utf8'));ok(await importCurrent(db.pool,JSON.stringify(n)));ok(await publishCurrent(db.pool,{templateId:n.templateId,requestId:'new'}));expect(ok(await loadTemplate(db.pool,n.docKey,1)).template.definition.nodeModelVersion).toBe(16);
 }finally{await db.close();}
});
