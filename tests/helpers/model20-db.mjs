import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {model20Fixture} from './model20.mjs';
export const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value};
export function fixture(model,key){
 const t=model===18?JSON.parse(readFileSync('examples/area-document-template.json','utf8')):model20Fixture();
 let request=model===18?JSON.parse(readFileSync('examples/area-document-request.json','utf8')):structuredClone(t.examples[0].request);
 if(model===19){t.nodeModelVersion=19;for(const s of t.sections)delete s.sectionKey;request.sections=request.sections.slice(0,2).map((r,i)=>({id:t.sections[i].id,data:r.data,...(r.header?{header:r.header}:{}),...(r.footer?{footer:r.footer}:{})}));}
 t.templateId=t.docKey=key;request.docKey=key;request.version=t.version;t.examples=[{name:'sample',request}];ok(validateTemplate(t));return{t,request};
}
export function prepared(t,request){return ok(prepareGeneration(ok(validateTemplate(t)),request));}
export async function baselineDir(){const d=await mkdtemp(join(tmpdir(),'m20-baseline-'));for(const n of readdirSync('migrations').filter(n=>/^\d{3}_/.test(n)&&n<'028_'))await copyFile('migrations/'+n,join(d,n));return d;}
export async function removeDir(d){if(!d.startsWith(join(tmpdir(),'m20-')))throw Error('Unexpected test directory');await rm(d,{recursive:true,force:true});}
export async function insertJob(pool,{versionId=null,preview=null,t,request,p=prepared(t,request),format='pdf'}){
 const id=randomUUID(),accepted=prepared(t,request);await pool.query('INSERT INTO generation_jobs(id,template_version_id,original_input,prepared_input,warnings_json,skipped_indices,preview_template_id,preview_revision,preview_definition,preview_fingerprint,output_format) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,versionId,request,p,JSON.stringify(accepted.warnings),JSON.stringify(accepted.skippedContentIndices),preview?t.templateId:null,preview?1:null,preview?t:null,preview?ok(validateTemplate(t)).fingerprint:null,format]);return id;
}
