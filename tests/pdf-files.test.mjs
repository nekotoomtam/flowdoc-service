import {it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const api=await import('../dist/storage/pdf-files.js').catch(()=>({}));
it('writes generated files, rejects paths, cleans only stale owned inactive files',async()=>{
 expect(api.createPdfFiles).toBeTypeOf('function');
 const root=await mkdtemp(join(tmpdir(),'flowdoc-files-')),files=await api.createPdfFiles(root);
 const id=randomUUID(),bytes=Buffer.from('%PDF-1.7\nfixture');const output=await files.writePdf(id,bytes);
 expect(await readFile(join(root,output.path))).toEqual(bytes);
 await expect(files.writePdf('../escape',bytes)).rejects.toThrow();
 await expect(files.openPdf('../escape')).rejects.toThrow();
 await writeFile(join(root,'unrelated.txt'),'keep');
 await utimes(join(root,output.path),new Date(0),new Date(0));
 await files.cleanupOrphans(new Set([output.path]),1000);expect(await readFile(join(root,output.path))).toEqual(bytes);
 output.release();await files.cleanupOrphans(new Set(),1000);await expect(readFile(join(root,output.path))).rejects.toThrow();expect(await readFile(join(root,'unrelated.txt'),'utf8')).toBe('keep');
});
it('validates explicit retention configuration',async()=>{
 expect(api.readFilePolicy).toBeTypeOf('function');expect(api.readFilePolicy({})).toMatchObject({retain:false,ttlHours:24});
 expect(api.readFilePolicy({EXPORT_RETAIN_FILES:'true',EXPORT_FILE_TTL_HOURS:'48'})).toMatchObject({retain:true,ttlHours:48});
 expect(()=>api.readFilePolicy({EXPORT_RETAIN_FILES:'yes'})).toThrow();expect(()=>api.readFilePolicy({EXPORT_TEMP_FILE_TTL_HOURS:'0'})).toThrow();
});
it('protects the renamed PDF until publication releases it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flowdoc-publish-')),files=await api.createPdfFiles(root),id=randomUUID();
 const output=await files.writePdf(id,Buffer.from('%PDF-test'));await files.cleanupOrphans(new Set(),0);expect(await readFile(join(root,output.path))).toBeTruthy();output.release();await files.cleanupOrphans(new Set(),0);await expect(readFile(join(root,output.path))).rejects.toThrow();
});
