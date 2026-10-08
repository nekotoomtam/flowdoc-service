import {it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateTemplate,prepareGeneration,composeDocument,loadBundledResources,createPdfEngine} from '@flowdoc/core';
import {registerTemplate,loadTemplate} from '../dist/templates/registry.js';
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
it('renders the same SRS PDF from the source and the stored version graph',async()=>{
 const p=new Pool({connectionString:process.env.DATABASE_URL});try{
 const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));t.templateId='tpl-render-version';t.docKey='render-version';ok(await registerTemplate(p,JSON.stringify(t)));
 const a=ok(validateTemplate(t)),b=ok(await loadTemplate(p,t.docKey,1)).template;expect(b.fingerprint).toBe(a.fingerprint);
 const input=JSON.parse(readFileSync('examples/srs-request.json','utf8'));input.docKey=t.docKey;
 const resources=ok(await loadBundledResources({pythonExecutable:'python',tempRoot:await mkdtemp(join(tmpdir(),'flowdoc-version-'))})),engine=ok(await createPdfEngine(resources));
 const pdf=[];for(const v of [a,b])pdf.push(ok(await engine.generatePdf(ok(composeDocument(v,ok(prepareGeneration(v,input)))))));
 expect(pdf[0].pageCount).toBeGreaterThan(0);expect(Buffer.from(pdf[1].bytes)).toEqual(Buffer.from(pdf[0].bytes));
 }finally{await p.end();}
},60000);
