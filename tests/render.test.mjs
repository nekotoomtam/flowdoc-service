import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {renderPinnedJob} from '../dist/jobs/render.js';
const t=validateTemplate(readFileSync('examples/srs-template.json','utf8')).value;
const p=prepareGeneration(t,JSON.parse(readFileSync('examples/srs-request.json','utf8'))).value;
it('renders the prepared document without transporting unused composition inputs',async()=>{
 const document=composeDocument(t,p).value;
 const reference=await renderPinnedJob(p,t.definition);
 // The processor has already checked the pinned template before preparing images.
 // These unused inputs must neither be serialized nor validated by the child.
 const unused={toJSON(){throw Error('unused composition input serialized');}};
 const actual=await renderPinnedJob(unused,unused,undefined,10000,52428800,undefined,{document,images:{}});
 expect(actual.ok,JSON.stringify(actual)).toBe(true);
 expect(reference.ok,JSON.stringify(reference)).toBe(true);
 expect(Buffer.from(actual.value.bytes)).toEqual(Buffer.from(reference.value.bytes));
},30000);
it('still rejects invalid documents and bounds the prepared-document render path',async()=>{
 const document=composeDocument(t,p).value;
 const images={document,images:{}};
 const invalid=structuredClone(document);invalid.nodes[invalid.rootIds[0]].type='unsupported';
 expect((await renderPinnedJob(p,t.definition,undefined,10000,52428800,undefined,{document:invalid,images:{}})).ok).toBe(false);
 expect((await renderPinnedJob(p,t.definition,undefined,1,52428800,undefined,images)).ok).toBe(false);
 expect((await renderPinnedJob(p,t.definition,undefined,10000,1,undefined,images)).ok).toBe(false);
},30000);
it('isolated renderer returns a real PDF and bounds timeout/output',async()=>{
 const pdf=await renderPinnedJob(p,t.definition);expect(pdf.ok,JSON.stringify(pdf)).toBe(true);expect(Buffer.from(pdf.value.bytes).subarray(0,5).toString()).toBe('%PDF-');
 expect((await renderPinnedJob(p,t.definition,undefined,1)).ok).toBe(false);
 expect((await renderPinnedJob(p,t.definition,undefined,120000,1)).ok).toBe(false);
 expect((await renderPinnedJob(p,{})).ok).toBe(false);
},60000);
it('cleans parent-owned render workspace after forced termination',async()=>{
 const {mkdtemp,readdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'flowdoc-render-test-'));
 const abort=new AbortController();let saw=false;const timer=setInterval(async()=>{if((await readdir(root)).length){saw=true;abort.abort();}},1);
 await renderPinnedJob(p,t.definition,abort.signal,500,52428800,root);clearInterval(timer);expect(saw).toBe(true);
 expect(await readdir(root)).toEqual([]);
});
