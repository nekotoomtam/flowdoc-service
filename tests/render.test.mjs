import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {renderPinnedJob,renderDocumentJob} from '../dist/jobs/render.js';
const t=validateTemplate(readFileSync('examples/srs-template.json','utf8')).value;
const p=prepareGeneration(t,JSON.parse(readFileSync('examples/srs-request.json','utf8'))).value;
it('hands off serialized document data before yielding to the renderer',async()=>{
 const document=composeDocument(t,p).value;
 const expected=await renderPinnedJob(p,t.definition);
 const pending=renderDocumentJob({document,images:{}});
 document.rootIds.length=0;document.nodes={};
 const actual=await pending;
 expect(actual.ok,JSON.stringify(actual)).toBe(true);
 expect(expected.ok,JSON.stringify(expected)).toBe(true);
 expect(Buffer.from(actual.value.bytes)).toEqual(Buffer.from(expected.value.bytes));
},30000);
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
it('confirms native descendant exit before resolving a legacy renderer whose direct child was killed',async()=>{
 const {mkdtemp,writeFile,readFile,readdir,chmod}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'legacy-group-')),marker=join(root,'native.json'),shim=join(root,'python-shim'),renders=join(root,'renders');const old=process.env.PYTHON_EXECUTABLE;
 await writeFile(shim,'#!/usr/bin/env python3\nimport os,json,time\nwith open('+JSON.stringify(marker)+',"w") as f: json.dump({"pid":os.getpid(),"parent":os.getppid(),"group":os.getpgrp()},f)\nwhile True: time.sleep(1)\n');await chmod(shim,0o755);process.env.PYTHON_EXECUTABLE=shim;let native;
 const pending=renderPinnedJob(p,t.definition,undefined,10000,52428800,renders);try{const end=Date.now()+5000;while(!native){try{native=JSON.parse(await readFile(marker,'utf8'));}catch{}if(Date.now()>end)throw Error('native shim was not invoked');await new Promise(r=>setTimeout(r,10));}process.kill(native.parent,'SIGKILL');expect((await pending).ok).toBe(false);
 const stoppedBy=Date.now()+1000;let alive=true;while(Date.now()<stoppedBy){try{process.kill(native.pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,10));}expect(alive).toBe(false);expect(await readdir(renders)).toEqual([]);
 }finally{if(native)try{process.kill(-native.group,'SIGKILL');}catch{}if(old===undefined)delete process.env.PYTHON_EXECUTABLE;else process.env.PYTHON_EXECUTABLE=old;await pending;}
},15000);
