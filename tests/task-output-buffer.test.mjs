import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {createPdfOutputBuffer} from '../dist/tasks/output-buffer.js';
const bytes=65536;
it('coalesces tiny writes, preserves exact bytes, and flushes the last tail before completion',async()=>{
 const chunks=[],signal=new AbortController().signal,sink=createPdfOutputBuffer(async b=>chunks.push(Buffer.from(b)),signal);
 const input=Buffer.alloc(bytes*2+37);for(let i=0;i<input.length;i++)input[i]=i%251;
 for(let i=0;i<input.length;i+=19)await sink.write(input.subarray(i,i+19));
 expect(chunks.map(b=>b.length)).toEqual([bytes,bytes]);
 await sink.finish();expect(chunks.map(b=>b.length)).toEqual([bytes,bytes,37]);
 expect(Buffer.concat(chunks)).toEqual(input);expect(createHash('sha256').update(Buffer.concat(chunks)).digest('hex')).toBe(createHash('sha256').update(input).digest('hex'));
});
it('copies caller-owned tails and accepts an input larger than its fixed buffer',async()=>{
 const chunks=[],sink=createPdfOutputBuffer(async b=>chunks.push(Buffer.from(b)),new AbortController().signal);
 const first=Buffer.from('first');await sink.write(first);first.fill(0);
 const large=Buffer.alloc(bytes*3+12,27);await sink.write(large);await sink.finish();
 expect(chunks.every(b=>b.length<=bytes)).toBe(true);expect(Buffer.concat(chunks)).toEqual(Buffer.concat([Buffer.from('first'),large]));
});
it('awaits one downstream write and leaves its bytes stable until acknowledgement',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let calls=0,active=0,peak=0;
 const chunks=[],sink=createPdfOutputBuffer(async b=>{calls++;active++;peak=Math.max(peak,active);const before=Buffer.from(b);if(calls===1){enter();await gate;expect(Buffer.from(b)).toEqual(before);}chunks.push(Buffer.from(b));active--;},new AbortController().signal);
 const input=Buffer.alloc(bytes*2+9,19),pending=sink.write(input);await entered;expect(calls).toBe(1);release();await pending;await sink.finish();expect(peak).toBe(1);expect(Buffer.concat(chunks)).toEqual(input);
});
it('drops a buffered tail on abort and never sends it during finish',async()=>{
 const chunks=[],controller=new AbortController(),sink=createPdfOutputBuffer(async b=>chunks.push(Buffer.from(b)),controller.signal);
 await sink.write(Buffer.from('unsent'));controller.abort(Error('cancelled'));sink.abort();
 await expect(sink.finish()).rejects.toThrow('cancelled');expect(chunks).toHaveLength(0);
});
it('stops after an in-flight write acknowledges cancellation and never writes the next block',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),controller=new AbortController();let calls=0;
 const sink=createPdfOutputBuffer(async()=>{calls++;enter();await gate;},controller.signal),pending=sink.write(Buffer.alloc(bytes*2));await entered;controller.abort(Error('disconnected'));release();
 await expect(pending).rejects.toThrow('disconnected');await expect(sink.finish()).rejects.toThrow('disconnected');expect(calls).toBe(1);
});
it('does not retry a rejected downstream write or flush a failed buffer later',async()=>{
 let calls=0;const failure=Object.assign(Error('full'),{code:'STORAGE_CAPACITY'}),sink=createPdfOutputBuffer(async()=>{calls++;throw failure;},new AbortController().signal);
 await expect(sink.write(Buffer.alloc(bytes+20))).rejects.toBe(failure);await expect(sink.finish()).rejects.toBe(failure);await expect(sink.write(Buffer.from('again'))).rejects.toBe(failure);expect(calls).toBe(1);
});
it('propagates failure of the final partial write before completion',async()=>{
 const failure=Error('tail failed');let calls=0;const sink=createPdfOutputBuffer(async()=>{calls++;throw failure;},new AbortController().signal);
 await sink.write(Buffer.from('tail'));await expect(sink.finish()).rejects.toBe(failure);sink.abort();expect(calls).toBe(1);
});
it('finishes an empty buffer without a write and rejects writes after finish',async()=>{
 let calls=0;const sink=createPdfOutputBuffer(async()=>{calls++;},new AbortController().signal);await sink.finish();expect(calls).toBe(0);await expect(sink.write(Buffer.from('late'))).rejects.toThrow();
});
