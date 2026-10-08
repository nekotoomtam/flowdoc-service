import {it,expect,beforeAll,afterAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {importCurrent,saveCurrent} from '../dist/templates/current.js';
import {publishCurrent} from '../dist/templates/publish.js';
import {loadTemplate} from '../dist/templates/registry.js';
import {decompose} from '../dist/templates/assembly.js';
const db=isolatedDatabase();const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
beforeAll(async()=>{await db.setup();ok(await migrate(db.pool));});afterAll(()=>db.close());
function template(){const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));t.templateId='image-master';t.docKey='image-master';t.nodeModelVersion=5;t.globalSchema={type:'object',fields:{photo:{type:'image'}}};t.formats={photo:{inputSchema:{type:'object',fields:{photo:{type:'image'}}},fragment:{rootIds:['p'],nodes:{p:{id:'p',type:'image',props:{width:{value:100,unit:'pt'},height:{value:100,unit:'pt'},source:{scope:'local',key:'photo'}}}}},repeats:[]}};t.examples=[];return t;}
it('maps image to its master rather than array and rejects unknown types',()=>{const t=template();expect(decompose(t,randomUUID).variables.map(v=>v.typeId)).toEqual([110004,110004]);t.globalSchema.fields.photo.type='unknown';expect(()=>decompose(t,randomUUID)).toThrow();});
it('registers image master, clones image variables and preserves old published data after current deletion',async()=>{
 expect((await db.pool.query('SELECT code FROM variable_types WHERE id=110004')).rows).toEqual([{code:'image'}]);
 const t=template();let current=ok(await importCurrent(db.pool,JSON.stringify(t)));expect(current.variables.map(v=>v.typeId)).toEqual([110004,110004]);
 const published=ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'image-v1'}));
 const rows=(await db.pool.query('SELECT v.id,v.source_variable_id,v.type_id FROM variable_versions v JOIN variable_schema_versions s ON s.id=v.schema_version_id WHERE s.template_version_id=$1',[published.versionId])).rows;
 expect(rows).toHaveLength(2);for(const row of rows){expect(row.type_id).toBe(110004);expect(current.variables.some(v=>v.id===row.source_variable_id)).toBe(true);expect(row.id).not.toBe(row.source_variable_id);}
 const global=current.schemas.find(s=>s.formatId===null);current.variables=current.variables.filter(v=>v.schemaId!==global.id);ok(await saveCurrent(db.pool,current,current.revision));
 expect(ok(await loadTemplate(db.pool,t.docKey,1)).template.definition.globalSchema.fields.photo.type).toBe('image');
 await expect(db.pool.query('DELETE FROM variable_types WHERE id=110004')).rejects.toMatchObject({code:'23503'});
});
it('does not silently accept image jobs before resource claiming is connected',async()=>{const {submitJob}=await import('../dist/jobs/admission.js');const t=template();t.templateId='image-job-guard';t.docKey=t.templateId;ok(await importCurrent(db.pool,JSON.stringify(t)));ok(await publishCurrent(db.pool,{templateId:t.templateId,requestId:'first'}));const result=await submitJob(db.pool,{docKey:t.docKey,data:{},content:[{format:'photo',data:{photo:'01a11aa0-c9e6-780a-ae76-834fad559f4d'}}]});expect(result).toMatchObject({ok:false,issues:[{code:'IMAGE_JOBS_UNAVAILABLE'}]});expect(Number((await db.pool.query('SELECT count(*) FROM generation_jobs')).rows[0].count)).toBe(0);});
