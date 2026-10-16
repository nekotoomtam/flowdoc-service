import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
import {renderPinnedJob} from '../dist/jobs/render.js';
it('renders the full Thai authoring trial without shortening or replacing text',async()=>{
 const definition=JSON.parse(readFileSync('examples/thai-authoring-template.json','utf8'));
 const request=JSON.parse(readFileSync('examples/thai-authoring-request.json','utf8'));
 const valid=validateTemplate(definition);expect(valid.ok,JSON.stringify(valid)).toBe(true);
 const prepared=prepareGeneration(valid.value,request);expect(prepared.ok,JSON.stringify(prepared)).toBe(true);
 const rendered=await renderPinnedJob(prepared.value,definition);expect(rendered.ok,JSON.stringify(rendered.ok?{}:rendered)).toBe(true);
 expect(Buffer.from(rendered.value.bytes).subarray(0,5).toString()).toBe('%PDF-');
},30000);
