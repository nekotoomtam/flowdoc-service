import {it,expect} from 'vitest';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
const api=await import('../dist/tools/authoring.js').catch(()=>({}));
it('exposes bounded authoring tools without publish, sends host credentials and reads PDFs as resources',async()=>{
 expect(api.createAuthoringTools).toBeTypeOf('function');const calls=[];
 const server=api.createAuthoringTools({baseUrl:'http://127.0.0.1:3000',token:'x'.repeat(40),fetch:async(url,init)=>{calls.push({url:String(url),init});return String(url).endsWith('/pdf')?new Response('%PDF-test',{headers:{'content-type':'application/pdf'}}):Response.json({ok:true,value:{revision:0},warnings:[]});}});
 const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{const list=await client.listTools();expect(list.tools.map(t=>t.name)).toContain('create_template_draft');expect(list.tools.some(t=>/publish|shell|sql/.test(t.name))).toBe(false);
  await client.callTool({name:'create_template_draft',arguments:{name:'Example',docKey:'example',idempotencyKey:'one'}});
  expect(calls[0].init.headers.authorization).toBe('Bearer '+'x'.repeat(40));expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('templateId');
  const pdf=await client.readResource({uri:'flowdoc-preview://00000000-0000-4000-8000-000000000000/pdf'});expect(pdf.contents[0].mimeType).toBe('application/pdf');
  await expect(client.readResource({uri:'file:///secret'})).rejects.toThrow();
 }finally{await client.close();await server.close();}
});
it('exposes catalog, revision-bound readiness and retained clone schemas without any administrator tools',async()=>{const server=api.createAuthoringTools({baseUrl:'http://127.0.0.1:3000',token:'a'.repeat(32),fetch:async()=>Response.json({ok:true,value:{},warnings:[]})}),client=new Client({name:'font-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);try{const names=(await client.listTools()).tools.map(t=>t.name);expect(names).toContain('get_font_catalog');expect(names).toContain('get_draft_font_readiness');expect(names).toContain('clone_template_draft');expect(names.some(n=>/activate|import_font|retire|review_font/.test(n))).toBe(false);}finally{await client.close();await server.close();}});
