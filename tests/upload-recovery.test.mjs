import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,PassThrough} from 'node:stream';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
const db=isolatedDatabase();let files,time=Date.now(),u;
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);files=await createResourceFiles(await mkdtemp(join(tmpdir(),'flowdoc-recovery-')));u=createUploads({pool:db.pool,files,clock:()=>time,config:readUploadConfig({UPLOAD_STREAMS:'1'})});});
afterAll(async()=>{await u.stop();await db.close();});
const manifest=requestKey=>({requestKey,items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:3}]});
it('does not delete an active receive, refuses extra streams, and drains stop',async()=>{
 const s=await u.create(manifest('active')),input=new PassThrough();
 const result=u.receive(s.uploadId,s.items[0].resourceId,input);const rejected=expect(result).rejects.toThrow();
 await expect(u.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]))).rejects.toThrow('busy');
 time+=3600001;await u.cleanup();await u.stop();await rejected;
 expect(u.activeCount).toBe(0);
 u=createUploads({pool:db.pool,files,clock:()=>time,config:readUploadConfig({})});await u.recover();
});
it('does not claim ready after a persisted file goes missing',async()=>{
 const s=await u.create(manifest('missing'));await u.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]));await u.finalize(s.uploadId);
 const name=(await db.pool.query('SELECT storage_key FROM upload_items WHERE id=$1',[s.items[0].resourceId])).rows[0].storage_key;await files.remove(name);
 await u.recover();expect((await u.get(s.uploadId)).status).not.toBe('ready');await expect(u.finalize(s.uploadId)).rejects.toThrow();
});
it('reservations serialize competing session creation',async()=>{
 const small=createUploads({pool:db.pool,files,clock:()=>time,config:readUploadConfig({UPLOAD_FILE_BYTES:'3',UPLOAD_SET_BYTES:'3',UPLOAD_STAGING_BYTES:'3'})});
 const r=await Promise.allSettled([small.create(manifest('quota-a')),small.create(manifest('quota-b'))]);
 expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});
it('does not release quota or attempt ownership while deletion fails',async()=>{
 let broken=true;
 const failing=createUploads({pool:db.pool,files:{...files,receive:async()=>{throw Error('write failure');},remove:async name=>{if(broken)throw Error('unlink failure');return files.remove(name);}},clock:()=>time,config:readUploadConfig({})});
 const s=await failing.create(manifest('unlink'));await expect(failing.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]))).rejects.toThrow();
 expect((await db.pool.query('SELECT attempt_id FROM upload_items WHERE id=$1',[s.items[0].resourceId])).rows[0].attempt_id).toBeTruthy();
 time+=3600001;await expect(failing.cleanup()).rejects.toThrow();
 expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(3);
 broken=false;await failing.cleanup();expect(Number((await db.pool.query('SELECT reserved_bytes FROM upload_sessions WHERE id=$1',[s.uploadId])).rows[0].reserved_bytes)).toBe(0);
});
it('does not revive an expired session when its first bytes arrive late',async()=>{
 const s=await u.create(manifest('late')),input=new PassThrough();const receive=u.receive(s.uploadId,s.items[0].resourceId,input);
 const rejected=expect(receive).rejects.toThrow();
 for(let n=0;n<50;n++){if((await db.pool.query('SELECT attempt_id FROM upload_items WHERE id=$1',[s.items[0].resourceId])).rows[0].attempt_id)break;await new Promise(r=>setTimeout(r,5));}
 time+=3600000;input.end(Buffer.from('abc'));await rejected;
 expect((await u.get(s.uploadId)).status).toBe('expired');
});
