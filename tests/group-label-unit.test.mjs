import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration,composeDocument} from '@flowdoc/core';
import {fontProbeDocument} from '../dist/fonts/probe.js';
import {locateMissingGlyphs} from '../dist/fonts/readiness.js';
import {validateFontSnapshot,makeFontSnapshot} from '../dist/fonts/snapshot.js';
import {createServer} from '../dist/http/server.js';
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
import {fixture} from './groupLabelFixture.mjs';
it('uses the packed group-label contract and probes generated continuation in the label font only for auto',()=>{
 for(const fixed of [false,true]){
  const {t,q}=fixture({fixed}),v=ok(validateTemplate(t)),d=ok(composeDocument(v,ok(prepareGeneration(v,q)))),before=JSON.stringify(d),p=fontProbeDocument(d);
  const text=Object.values(p.nodes).flatMap(n=>n.children??[]).map(c=>c.text??'').join('');
  expect(text.includes(' (ต่อ)')).toBe(!fixed);expect(JSON.stringify(d)).toBe(before);
  const coverage=new Map([['body',new Set([...new Set(text)].filter(ch=>ch!=='ต').map(ch=>ch.codePointAt(0)))]]);
  const issues=locateMissingGlyphs(d,coverage);expect(issues.some(i=>i.samples.includes('U+0E15'))).toBe(!fixed);
 }
});
it('rejects a job snapshot pinned to a different engine even when the definition/input match',()=>{
 const snapshot=makeFontSnapshot('a'.repeat(64),'b'.repeat(64),[]);
 expect(validateFontSnapshot(snapshot,'a'.repeat(64),'b'.repeat(64))).toEqual(snapshot);
 expect(()=>validateFontSnapshot({...snapshot,rendererIdentity:{...snapshot.rendererIdentity,sha256:'c'.repeat(64)}},'a'.repeat(64),'b'.repeat(64))).toThrow();
});
it('advertises the exact optional group label contract only behind authoring authorization',async()=>{
 const app=createServer({pool:{},isReady:()=>true,outputs:{},imagesEnabled:false,authoring:{token:'a'.repeat(40),principal:'label-owner'}});
 try{
  expect((await app.inject('/authoring/contract')).statusCode).toBe(401);
  const r=await app.inject({url:'/authoring/contract',headers:{authorization:'Bearer '+'a'.repeat(40)}});
  expect(r.json().value.groupLabelSpans).toEqual({version:1,nodeModelVersions:[19],schemaVersions:[1,2],continuationSuffix:' (ต่อ)',fixed:'formatSizing-v2',diagnosticsVersion:1});
 }finally{await app.close();}
});
