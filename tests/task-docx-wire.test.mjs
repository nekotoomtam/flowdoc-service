import {it,expect} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {taskWire} from '../dist/tasks/wire.js';
const api=await import('../dist/tasks/artifact.js').catch(()=>({}));
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
it('validates discriminated artifact receipts and trusted bounds',async()=>{
 expect(api.validateReceipt).toBeTypeOf('function');
 const receipt={byteLength:10,sha256:'a'.repeat(64),pageCount:null,mediaType:mime,fieldRefresh:'required',wordVerified:false,buffered:true};
 expect(()=>api.validateReceipt('docx',receipt,32*1048576)).not.toThrow();
 for(const change of [{pageCount:0},{pageCount:1},{mediaType:'application/pdf'},{buffered:false},{wordVerified:true},{fieldRefresh:'none'},{byteLength:33*1048576},{sha256:'bad'}])expect(()=>api.validateReceipt('docx',{...receipt,...change},32*1048576)).toThrow();
 expect(()=>api.validateReceipt('pdf',{byteLength:10,sha256:'a'.repeat(64),pageCount:1},256*1048576)).not.toThrow();
 expect(()=>api.validateReceipt('pdf',{...receipt,mediaType:'application/pdf'},256*1048576)).toThrow();
});
it('sends DOCX bytes with verified MIME, filename, hash and null page count in bounded writes',async()=>{
 const bytes=Buffer.alloc(150000,7);bytes.write('PK\x03\x04');const dir=await mkdtemp(join(tmpdir(),'docx-wire-')),path=join(dir,'owned.bin');await writeFile(path,bytes);
 const chunks=[];let ended=false;const wire=taskWire({start(){},async write(b){expect(b.length).toBeLessThanOrEqual(65536);chunks.push(Buffer.from(b));},async end(){ended=true;},async abort(){}},'task');
 expect(wire.artifact).toBeTypeOf('function');await wire.artifact(path,{outputFormat:'docx',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:null,completeness:'complete',fieldRefresh:'required',wordVerified:false,buffered:true},new AbortController().signal);
 const output=Buffer.concat(chunks);expect(ended).toBe(true);expect(output.includes(bytes)).toBe(true);expect(output.toString()).toContain('filename="document.docx"');expect(output.toString()).toContain('Content-Type: '+mime);expect(output.toString()).toContain('"pageCount":null');
});
it('rejects corrupt or mismatched DOCX metadata before artifact headers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'docx-wire-')),path=join(dir,'owned.bin');await writeFile(path,'PKbad');const chunks=[];const wire=taskWire({start(){},async write(b){chunks.push(Buffer.from(b));},async end(){},async abort(){}},'task');
 expect(wire.artifact).toBeTypeOf('function');
 await expect(wire.artifact(path,{outputFormat:'docx',bytes:5,sha256:'b'.repeat(64),pageCount:null,fieldRefresh:'required',wordVerified:false,buffered:true},new AbortController().signal)).rejects.toHaveProperty('code','STORAGE_IO');
 expect(Buffer.concat(chunks).length).toBe(0);
});
it('downloads only the Word artifact after validation with a safe name and bounded writes',async()=>{
 const bytes=Buffer.alloc(150000,7);bytes.write('PK\x03\x04');
 const path=join(await mkdtemp(join(tmpdir(),'docx-download-')),'owned.bin');await writeFile(path,bytes);
 const chunks=[];
 const starts=[];
 const wire=taskWire({start(...args){starts.push(args);},async write(b){expect(b.length).toBeLessThanOrEqual(65536);chunks.push(Buffer.from(b));},async end(){},async abort(){throw Error('Unexpected abort');}},'task',true);
 await wire.event('task','processing',{});
 expect(starts).toHaveLength(0);
 await wire.artifact(path,{...api.docxDisclosure,outputFormat:'docx',fileName:'ทดสอบ',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:null,completeness:'complete'},new AbortController().signal);
 expect(starts).toEqual([[mime,expect.objectContaining({'Content-Length':bytes.length,'Content-Disposition':'attachment; filename="document.docx"; filename*=UTF-8\'\'%E0%B8%97%E0%B8%94%E0%B8%AA%E0%B8%AD%E0%B8%9A.docx'})]]);
 expect(Buffer.concat(chunks)).toEqual(bytes);
 expect(wire.ended).toBe(true);
});
it('leaves early Word errors unwritten so HTTP can send the JSON status',async()=>{
 const unexpected=()=>{throw Error('Unexpected transport use');};
 const wire=taskWire({start:unexpected,write:unexpected,end:unexpected,abort:unexpected},'task',true);
 await wire.event('progress','processing',{});
 await wire.error('RENDER_FAILED','composing','failed');
 expect(wire.started).toBe(false);
 expect(wire.ended).toBe(true);
});
it('downloads PDF bytes directly with PDF headers and no Word disclosure',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
 const path=join(await mkdtemp(join(tmpdir(),'pdf-download-')),'owned.bin');
 await writeFile(path,bytes);
 const chunks=[],starts=[];
 const digest=createHash('sha256').update(bytes).digest('hex');
 const wire=taskWire({
  start(...args){starts.push(args);},
  async write(chunk){chunks.push(Buffer.from(chunk));},
  async end(){},
  async abort(){throw Error('Unexpected abort');},
 },'task',true);
 await wire.event('task','processing',{});
 await wire.artifact(path,{outputFormat:'pdf',bytes:bytes.length,sha256:digest,pageCount:1,completeness:'complete'},new AbortController().signal);
 expect(starts).toEqual([['application/pdf',{
  'Content-Disposition':'attachment; filename="document.pdf"','Content-Length':bytes.length,
  'X-FlowDoc-SHA256':digest,'X-FlowDoc-Task-Id':'task','X-FlowDoc-Completeness':'complete',
 }]]);
 expect(Buffer.concat(chunks)).toEqual(bytes);
 expect(wire.ended).toBe(true);
});
