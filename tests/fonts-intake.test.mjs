import {beforeAll,afterAll,it,expect} from 'vitest';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const api=await import('../dist/fonts/inspection.js').catch(()=>({}));
const storage=await import('../dist/fonts/files.js').catch(()=>({}));
const hash=b=>createHash('sha256').update(b).digest('hex');
let root,files;
const regular=new URL('../node_modules/@flowdoc/core/assets/fonts/Sarabun-Regular.ttf',import.meta.url);
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'font-intake-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
it('inspects real static TTF bytes without deriving weight from the filename',async()=>{
 expect(api.inspectFont).toBeTypeOf('function');
 const r=await api.inspectFont(fileURLToPath(regular));
 expect(r.rawWeight).toBe(400);expect(r.style).toBe('normal');expect(r.names.family).toContain('Sarabun');
 expect(r.coverage).toContain(0x0e01);expect(r.coverageDigest).toMatch(/^[0-9a-f]{64}$/);
 expect(r.fileVersion).toBeTruthy();
});
it('rejects malformed TTF, OTF signatures and variable fonts',async()=>{
 expect(api.inspectFont).toBeTypeOf('function');
 const {writeFile}=await import('node:fs/promises');
 for(const [i,b] of [Buffer.from('not a font'),Buffer.from('OTTOgarbage'),Buffer.from('wOFFgarbage')].entries()){
  const p=join(root,'bad-'+i);await writeFile(p,b);await expect(api.inspectFont(p)).rejects.toMatchObject({code:'INVALID_FONT_FILE'});
 }
 // A real fvar table in an otherwise valid sfnt must also be rejected.
 const {execFileSync}=await import('node:child_process');
 const variable=join(root,'variable.ttf');
 execFileSync(process.env.PYTHON_EXECUTABLE??'python',['-c',"from fontTools.ttLib import TTFont,newTable; import sys; f=TTFont(sys.argv[1]); t=newTable('fvar'); t.axes=[]; t.instances=[]; f['fvar']=t; f.save(sys.argv[2])",fileURLToPath(regular),variable]);
 await expect(api.inspectFont(variable)).rejects.toMatchObject({code:'INVALID_FONT_FILE'});
});
it('stores verified bytes atomically, reuses hashes and rejects incomplete, changed or oversized streams',async()=>{
 expect(storage.createFontFiles).toBeTypeOf('function');
 files=await storage.createFontFiles(join(root,'store'));
 const b=await readFile(regular),id=randomUUID();
 const receive=(key,data,expected=b.length,digest=hash(b))=>files.receive(id,key,(async function*(){yield data;})(),{byteLength:expected,sha256:digest});
 const first=await receive('regular',b);expect(first.sha256).toBe(hash(b));
 await expect(receive('../escape',b)).rejects.toMatchObject({code:'INVALID_FONT_INPUT'});
 await expect(receive('short',b.subarray(1))).rejects.toMatchObject({code:'FONT_UPLOAD_INCOMPLETE'});
 await expect(receive('changed',b,b.length,'0'.repeat(64))).rejects.toMatchObject({code:'FONT_HASH_MISMATCH'});
 await expect(receive('large',b,10*1024*1024+1)).rejects.toMatchObject({code:'FONT_LIMIT_EXCEEDED'});
 const same=await files.promote(first.path,first.sha256);const replay=await files.promote(first.path,first.sha256);
 expect(same.storageKey).toBe(replay.storageKey);expect(replay.created).toBe(false);
 expect(await files.verify(same.storageKey,hash(b),b.length)).toBe(true);
 expect((await readdir(join(root,'store','staging',id))).filter(n=>n.endsWith('.part'))).toEqual([]);
});
it('cleans an aborted stalled upload and does not expose partial bytes',async()=>{
 expect(storage.createFontFiles).toBeTypeOf('function');
 const {PassThrough}=await import('node:stream');const input=new PassThrough(),abort=new AbortController(),id=randomUUID();
 const f=await storage.createFontFiles(join(root,'abort'));
 const pending=f.receive(id,'stalled',input,{byteLength:100,sha256:'0'.repeat(64)},abort.signal);
 setTimeout(()=>abort.abort(),20);await expect(pending).rejects.toThrow();
 expect(await readdir(join(root,'abort','staging',id))).toEqual([]);
});
it('keeps the upload deadline when the caller supplies an untriggered cancellation signal',async()=>{
 const {PassThrough}=await import('node:stream');
 const f=await storage.createFontFiles(join(root,'deadline'),{receiveTimeoutMs:30}),id=randomUUID();
 const caller=new AbortController(),pending=f.receive(id,'stalled',new PassThrough(),{byteLength:100,sha256:'0'.repeat(64)},caller.signal);
 const result=await Promise.race([pending.then(()=> 'accepted',()=> 'rejected'),new Promise(r=>setTimeout(()=>r('stalled'),250))]);
 caller.abort();await pending.catch(()=>{});
 expect(result).toBe('rejected');expect(await readdir(join(root,'deadline','staging',id))).toEqual([]);
});
