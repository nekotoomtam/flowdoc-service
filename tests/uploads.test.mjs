import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
const db=isolatedDatabase();let uploads,time=Date.now();
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);uploads=createUploads({pool:db.pool,files:await createResourceFiles(await mkdtemp(join(tmpdir(),'flowdoc-upload-'))),config:readUploadConfig({}),clock:()=>time});});
afterAll(()=>db.close());
it('retries identical manifest, receives exact bytes, rejects changed retry and finalizes',async()=>{
 const m={requestKey:'roundtrip',items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:3}]};
 const s=await uploads.create(m),id=s.uploadId,item=s.items[0].resourceId;
 expect((await uploads.create(m)).uploadId).toBe(id);
 await expect(uploads.create({...m,items:[]})).rejects.toThrow();await expect(uploads.finalize(id)).rejects.toThrow();
 await uploads.receive(id,item,Readable.from([Buffer.from('abc')]));
 await expect(uploads.receive(id,item,Readable.from([Buffer.from('xyz')]))).rejects.toThrow();
 expect((await uploads.receive(id,item,Readable.from([Buffer.from('abc')]))).received).toBe(1);
 expect((await uploads.finalize(id)).status).toBe('ready');expect((await uploads.finalize(id)).status).toBe('ready');
});
it('does not expose URL, expires without polling extending lifetime and purges bytes',async()=>{
 const s=await uploads.create({requestKey:'url',items:[{key:'u',source:'url',url:'https://example.org/a?secret=value'}]});
 expect(JSON.stringify(s)).not.toContain('secret');await uploads.finalize(s.uploadId);
 time+=3600001;expect((await uploads.get(s.uploadId)).status).toBe('expired');await uploads.cleanup();
 const row=(await db.pool.query('SELECT source_url FROM upload_items WHERE upload_id=$1',[s.uploadId])).rows[0];expect(row.source_url).toBeNull();
});
it('allows retry after short body and survives recovery',async()=>{
 const s=await uploads.create({requestKey:'incomplete',items:[{key:'a',source:'upload',mediaType:'image/jpeg',byteSize:3}]});
 await expect(uploads.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('a')]))).rejects.toThrow();
 expect((await uploads.get(s.uploadId)).items[0].status).toBe('incomplete');
 await uploads.receive(s.uploadId,s.items[0].resourceId,Readable.from([Buffer.from('abc')]));await uploads.recover();
 expect((await uploads.finalize(s.uploadId)).status).toBe('ready');
});
