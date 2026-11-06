import {it,expect,describe,beforeAll,afterAll} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as render from '../dist/jobs/render.js';
import {createFontPreflightGate} from '../dist/fonts/preflight-gate.js';
import {resolveFontReadiness} from '../dist/fonts/readiness.js';
import {fakeLauncher,deferred,pdf} from './helpers/worker-adapter-fixture.mjs';
const client={query:async()=>({rows:[{locked:true}]})};
it('does not return legacy success if cancelled while stop proof is pending',async()=>{
 const stop=deferred(),f=fakeLauncher({holdStop:stop.promise}),abort=new AbortController();const p=render.createJobRenderer(f.launcher).renderDocumentJob({document:{},images:{}},abort.signal);await new Promise(r=>setTimeout(r,20));expect(f.trace.some(x=>x[0]==='stop')).toBe(true);abort.abort();stop.resolve();expect(await p).toMatchObject({ok:false,issues:[{code:'RENDER_FAILED'}]});
});
it('reports unconfirmed abort even if the child never closes and preserves its scratch',async()=>{
 const f=fakeLauncher({unknown:true,mode:'silent'}),abort=new AbortController();const p=render.createJobRenderer(f.launcher).renderDocumentJob({document:{},images:{}},abort.signal);const rejected=expect(p).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});await new Promise(r=>setTimeout(r,20));abort.abort();await rejected;const temp=f.trace[0][1].env.FLOWDOC_RENDER_TEMP;expect((await stat(temp)).isDirectory()).toBe(true);await rm(temp,{recursive:true,force:true});
},1000);
it('serializes before bind, then sends binary legacy input only after start and confirms stop',async()=>{
 const bind=deferred(),f=fakeLauncher({holdBind:bind.promise}),r=render.createJobRenderer(f.launcher);const data={document:{mark:'original'},images:{}};
 const p=r.renderDocumentJob(data);data.document.mark='changed';await new Promise(r=>setTimeout(r,15));expect(f.trace.map(x=>x[0])).toEqual(['spawn','bind']);bind.resolve();const result=await p;
 expect(result.ok).toBe(true);expect(result.value.bytes).toEqual(pdf);expect(JSON.parse(f.trace.find(x=>x[0]==='stdin')[1]).imageInput.document.mark).toBe('original');expect(f.trace.map(x=>x[0])).toEqual(['spawn','bind','start','stdin','stop']);
});
it('keeps font worker credit until stop confirmation and never acquires a second credit',async()=>{
 const stop=deferred(),f=fakeLauncher({holdStop:stop.promise});let acquired=0,released=0;const gate=createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>{acquired++;return{release(){released++;}};}},render.createJobRenderer(f.launcher,'font-preflight').renderDocumentJob);
 const p=gate.run(client,undefined,s=>gate.render({document:{},images:{}},s));await new Promise(r=>setTimeout(r,20));expect(acquired).toBe(1);expect(released).toBe(0);stop.resolve();expect((await p).ok).toBe(true);expect(released).toBe(1);await gate.stop();
});
it('poisons preflight and retains credit on unconfirmed group stop',async()=>{
 const f=fakeLauncher({unknown:true});let released=0;const gate=createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>({release(){released++;}})},render.createJobRenderer(f.launcher,'font-preflight').renderDocumentJob);
 await expect(gate.run(client,undefined,s=>gate.render({document:{},images:{}},s))).rejects.toMatchObject({code:'UNAVAILABLE'});expect(released).toBe(0);expect(gate.isReady()).toBe(false);await expect(gate.stop()).rejects.toMatchObject({code:'UNAVAILABLE'});
});
it('preserves layout codes and existing binary output cap',async()=>{
 const bad=fakeLauncher({exitCode:1,issues:[{code:'LAYOUT_FAILED',nodeId:'p',reason:'group-label-does-not-fit'}]});const r=await render.createJobRenderer(bad.launcher).renderDocumentJob({document:{},images:{}});expect(r).toMatchObject({ok:false,issues:[{code:'LAYOUT_FAILED',nodeId:'p'}]});
 const f=fakeLauncher();expect(await render.createJobRenderer(f.launcher).renderPinnedJob({}, {},undefined,1000,3)).toMatchObject({ok:false,issues:[{code:'RENDER_FAILED'}]});expect(f.trace.some(x=>x[0]==='stop')).toBe(true);
});
it('fails closed in required mode without renderer injection before starting processor or native work',async()=>{
 const before=process.env.FLOWDOC_WORKER_ISOLATION;process.env.FLOWDOC_WORKER_ISOLATION='required';try{
  await expect(render.renderDocumentJob({document:{},images:{}})).rejects.toMatchObject({code:'WORKER_RENDERER_REQUIRED'});
  const {startProcessor}=await import('../dist/jobs/processor.js');let touched=false;await expect(startProcessor({pool:{connect(){touched=true;throw Error('DB touched');}}})).rejects.toMatchObject({code:'WORKER_RENDERER_REQUIRED'});expect(touched).toBe(false);
  await expect(createFontPreflightGate().run(client,undefined,async()=>0)).rejects.toMatchObject({code:'UNAVAILABLE'});
 }finally{if(before===undefined)delete process.env.FLOWDOC_WORKER_ISOLATION;else process.env.FLOWDOC_WORKER_ISOLATION=before;}
});
it('readiness uses the injected renderer inside the existing gate permit and credit',async()=>{
 let active=false,calls=0;const gate=createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>{active=true;return{release(){active=false;}};}},async()=>{expect(active).toBe(true);calls++;return{ok:true,value:{bytes:pdf,mediaType:'application/pdf'},warnings:[]};});
 const result=await resolveFontReadiness(client,{schemaVersion:1,styles:{}},'a'.repeat(64),null,{document:{nodes:{},styles:{}},input:{}},undefined,{deferFiles:true,preflight:gate});expect(result.readiness.status).toBe('ready');expect(calls).toBe(1);expect(active).toBe(false);await gate.stop();
});

describe.skipIf(!process.env.FLOWDOC_WORKER_LAB)('P2 actual adapters in Oracle Linux lab',()=>{
 let launcher,root;
 beforeAll(async()=>{
  const {createWorkerLauncher}=await import('../dist/workers/launcher.js');const {readWorkerConfig}=await import('../dist/workers/config.js');
  await writeFile('/results/app/coordinator-ready.json',JSON.stringify({pid:process.pid,start:(await readFile('/proc/self/stat','utf8')).split(')')[1].trim().split(/\s+/)[19]}));
  const end=Date.now()+20000;while(true){try{await readFile('/results/public-anchor.json');break;}catch{if(Date.now()>end)throw Error('lab anchor timeout');await new Promise(r=>setTimeout(r,20));}}
  launcher=await createWorkerLauncher(readWorkerConfig({FLOWDOC_WORKER_ISOLATION:'required',FLOWDOC_WORKER_BROKER_SOCKET:'/results/broker/service.sock',FLOWDOC_WORKER_ANCHOR:'/results/public-anchor.json'}));root=await mkdtemp(join(tmpdir(),'p2-native-'));
 },25000);
 afterAll(async()=>{await launcher?.drain();if(root)await rm(root,{recursive:true,force:true});});
 it('renders a real PDF and font preflight through fixed capped children',async()=>{
  const document={schemaVersion:1,nodeModelVersion:18,book:{contentSlot:'body',defaultPageLayoutId:'normal'},styles:{body:{fontFamilyKey:'sarabun',fontWeight:'normal',fontSize:{value:12,unit:'pt'},lineHeightPt:20}},pageLayouts:{normal:{page:{size:'A4',orientation:'portrait',margin:{top:{value:20,unit:'mm'},right:{value:20,unit:'mm'},bottom:{value:20,unit:'mm'},left:{value:20,unit:'mm'}}}}},rootIds:['p'],nodes:{p:{id:'p',type:'text-block',props:{textStyleId:'body'},children:[{id:'t',type:'text',text:'P2 ไทย English 123'}]}}};
  document.template={templateId:'p2',docKey:'p2',version:1};const {fontProbeDocument}=await import('../dist/fonts/probe.js');const input={document:fontProbeDocument(document),images:{}};const bounded=await render.createJobRenderer(launcher).renderDocumentJob(input);expect(bounded.ok,JSON.stringify(bounded)).toBe(true);expect(bounded.value.bytes.subarray(0,5).toString()).toBe('%PDF-');expect(bounded.value.bytes.length).toBeGreaterThan(1000);await writeFile('/results/app/legacy.pdf',bounded.value.bytes);
  let credits=0,grants=0;const gate=createFontPreflightGate({enabled:()=>true,ready:()=>true,tryAcquire:()=>{credits++;grants++;return{release(){credits--;}};}},render.createJobRenderer(launcher,'font-preflight').renderDocumentJob);const result=await resolveFontReadiness(client,{schemaVersion:1,styles:document.styles},'a'.repeat(64),null,{document:input.document,input:{}},undefined,{deferFiles:true,preflight:gate});expect(result.readiness.status,JSON.stringify(result)).toBe('ready');expect(grants).toBe(1);expect(credits).toBe(0);await gate.stop();
 },30000);
 it('runs the real image JSON worker, retains geometry and recovers after cancellation',async()=>{
  const sharp=(await import('sharp')).default;const {createImagePreparer}=await import('../dist/images/prepare.js');const prepare=createImagePreparer(launcher),source=join(root,'image.png');await sharp({create:{width:300,height:150,channels:4,background:{r:100,g:80,b:60,alpha:.5}}}).png().toFile(source);
  const input={sourcePath:source,outputDirectory:join(root,'images'),widthPt:72,heightPt:72};const r=await prepare(input);expect(r.status).toBe('prepared');expect(r.image).toMatchObject({width:200,height:100,mediaType:'image/png'});expect((await sharp(r.image.path).metadata()).hasAlpha).toBe(true);
  const abort=new AbortController();const pending=prepare({...input,signal:abort.signal});setTimeout(()=>abort.abort(),20);await expect(pending).rejects.toThrow();expect((await prepare(input)).status).toBe('prepared');
 },15000);
});
