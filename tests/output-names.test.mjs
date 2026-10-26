import {it,expect} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {inspectPayload} from '../dist/tasks/payload.js';
import {policyWith} from '../dist/tasks/policy.js';
import {taskWire} from '../dist/tasks/wire.js';
import {selectOutputName,outputDisposition,renderTaskPayload} from '../dist/tasks/output-name.js';
import {openTaskJson} from '../dist/tasks/json-reader.js';
it('selects request/default/legacy names and preserves the old ASCII header',()=>{
 expect(selectOutputName(' requested ','default')).toBe('requested');
 expect(selectOutputName(' ','default')).toBe('default');expect(selectOutputName(undefined)).toBe('document');
 expect(outputDisposition(undefined,'pdf')).toBe('attachment; filename="document.pdf"');
 expect(outputDisposition("ไทย's",'docx')).toContain('%27');
});
it('filters only root transport naming without removing nested business names',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'name-root-')),path=join(dir,'payload');await writeFile(path,JSON.stringify({fileName:'download',data:{fileName:'business'},sections:[]}));
 const reader=await openTaskJson(path);
 try{const entries=[];for await(const pair of renderTaskPayload(reader.value).properties())entries.push(pair);
 expect(entries.map(p=>p[0])).toEqual(['data','sections']);const business=[];for await(const [key,v] of entries[0][1].properties())business.push([key,await v.scalar()]);expect(business).toEqual([['fileName','business']]);
 }finally{await reader.close();}
});
async function inspect(value,raw=false){const dir=await mkdtemp(join(tmpdir(),'flowdoc-name-')),p=join(dir,'payload');await writeFile(p,raw?value:JSON.stringify(value));return inspectPayload(p,policyWith(),new AbortController().signal);}
it('accepts a top-level Thai base name without treating it as business data',async()=>{
 expect(await inspect({fileName:'  รายงาน CLIS 2602S  ',data:{},sections:[]})).toEqual({actorRef:null,reference:null,fileName:'รายงาน CLIS 2602S'});
});
it('treats blank overrides as absent and retains the old attribution shape',async()=>{
 expect(await inspect({fileName:'  ',data:{},sections:[]})).toMatchObject({fileName:null});
 expect(await inspect({data:{},sections:[],meta:{reference:'r1'}})).toEqual({actorRef:null,reference:'r1'});
});
it.each([null,3,{},['x'],'../x','x.pdf','x\r\nHeader: injected','NUL','ก'.repeat(81)])('rejects invalid request names: %j',async name=>{
 await expect(inspect({fileName:name,data:{},sections:[]})).rejects.toHaveProperty('code','INVALID_REQUEST');
});
it('rejects duplicate filename keys rather than silently choosing one',async()=>{
 await expect(inspect('{"fileName":"one","fileName":"two","data":{},"sections":[]}',true)).rejects.toHaveProperty('code','INVALID_REQUEST');
});
it.each(['pdf','docx'])('sends the requested Unicode name with the selected %s extension',async format=>{
 const dir=await mkdtemp(join(tmpdir(),'flowdoc-name-wire-')),path=join(dir,'uuid.bin'),bytes=Buffer.from(format==='pdf'?'%PDF-test':'PK-test');await writeFile(path,bytes);const parts=[];
 const response={start(){},async write(b){parts.push(Buffer.from(b));},async end(){},async abort(){}};
 await taskWire(response,'10000000-0000-4000-8000-000000000001').artifact(path,{fileName:'รายงาน CLIS',outputFormat:format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pageCount:format==='pdf'?1:null,completeness:'complete',...(format==='docx'?{mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',fieldRefresh:'required',wordVerified:false,buffered:true}:{})},new AbortController().signal);
 const out=Buffer.concat(parts).toString();expect(out).toContain("filename*=UTF-8''"+encodeURIComponent('รายงาน CLIS.'+format));expect(out).toContain('"fileName":"รายงาน CLIS"');expect(out).not.toContain('uuid.bin');
});
