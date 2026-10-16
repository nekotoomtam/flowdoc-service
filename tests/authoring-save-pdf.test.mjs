import {it,expect} from 'vitest';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createAuthoringTools} from '../dist/tools/authoring.js';
it('saves binary PDF directly without model transcription; failures leave no file and retries preserve previous files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flowdoc-save-test-'));let deny=false;
 const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.from(Array.from({length:100000},(_,i)=>i%256)),Buffer.from('\n%%EOF\n')]);
 const server=createAuthoringTools({baseUrl:'http://127.0.0.1:3000',token:'x'.repeat(40),previewDirectory:root,fetch:async(url,init)=>{expect(init.headers.authorization).toBe('Bearer '+'x'.repeat(40));expect(String(url)).toMatch(/\/authoring\/previews\/[\da-f-]+\/pdf$/);return deny?new Response('Forbidden',{status:403}):new Response(bytes,{headers:{'content-type':'application/pdf'}});}});
 const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try {
 const args={jobId:'00000000-0000-4000-8000-000000000000'};
 const result=await client.callTool({name:'save_preview_pdf',arguments:args});expect(result.isError).not.toBe(true);
 const output=JSON.parse(result.content[0].text);expect(output.ok).toBe(true);expect(isAbsolute(output.value.path)).toBe(true);
 expect(await readFile(output.value.path)).toEqual(bytes);expect(output.value.byteSize).toBe(bytes.length);expect(output.value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(JSON.stringify(result)).not.toContain(bytes.toString('base64'));
 const retry=JSON.parse((await client.callTool({name:'save_preview_pdf',arguments:args})).content[0].text);expect(retry.value.path).not.toBe(output.value.path);expect(await readFile(output.value.path)).toEqual(bytes);
 const before=await readdir(root);deny=true;expect((await client.callTool({name:'save_preview_pdf',arguments:args})).isError).toBe(true);expect(await readdir(root)).toEqual(before);
 expect((await client.callTool({name:'save_preview_pdf',arguments:{...args,path:'../../outside.pdf'}})).isError).toBe(true);
 } finally {await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});
