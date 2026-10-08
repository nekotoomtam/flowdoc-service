import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {renderPinnedJob} from '../dist/jobs/render.js';
const t=validateTemplate(readFileSync('examples/srs-template.json','utf8')).value;
const p=prepareGeneration(t,JSON.parse(readFileSync('examples/srs-request.json','utf8'))).value;
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
