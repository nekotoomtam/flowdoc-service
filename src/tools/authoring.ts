import {McpServer,ResourceTemplate} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {mkdir,mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
export function createAuthoringTools(config:{baseUrl:string;token:string;fetch?:typeof fetch;previewDirectory?:string}){
 const base=new URL(config.baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Invalid authoring URL');
 if(base.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Remote authoring requires HTTPS');
 if(config.token.length<32)throw Error('Authoring credential required');
 const request=config.fetch??fetch;
 async function call(route:string,method='GET',body?:unknown,pdf=false){
  const r=await request(new URL(route,base),{method,headers:{authorization:'Bearer '+config.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});
  if(pdf&&(!r.ok||!r.headers.get('content-type')?.startsWith('application/pdf')))throw Error('Preview unavailable');
  const max=pdf?52428800:4194304,reader=r.body?.getReader(),parts:Uint8Array[]=[];let size=0;
  try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error('Response exceeds limit');}parts.push(value);}}finally{reader?.releaseLock();}
  const bytes=Buffer.concat(parts);return pdf?bytes:JSON.parse(bytes.toString('utf8'));
 }
 const server=new McpServer({name:'flowdoc-authoring',version:'0.1.0'}),id=z.string().uuid(),key=z.string().min(1).max(200),json=z.record(z.string(),z.unknown());
 function tool(name:string,description:string,shape:Record<string,z.ZodType>,run:(args:any)=>Promise<any>,readOnly=false){
  server.registerTool(name,{description,inputSchema:z.object(shape).strict(),annotations:{readOnlyHint:readOnly,destructiveHint:name==='update_template_draft',idempotentHint:true,openWorldHint:false}},async(args)=>{
   try{const output=await run(args);return {content:[{type:'text' as const,text:JSON.stringify(output)}],isError:output.ok===false};}
   catch{return {content:[{type:'text' as const,text:'Authoring request failed; check service availability and retry with the same idempotency key.'}],isError:true};}
  });
 }
 tool('get_authoring_contract','Read supported authoring contract before creating a template. No publication tools are available.',{},()=>call('/authoring/contract'),true);
 tool('get_font_catalog','Read active releases and real weight/style faces only. Retired rights remain on the owned draft; catalog cannot grant them.',{cursor:id.optional(),limit:z.number().int().min(1).max(100).optional(),familyId:id.optional()},a=>call('/authoring/fonts?'+new URLSearchParams(Object.entries(a).map(([k,v])=>[k,String(v)] as [string,string])) ),true);
 tool('get_draft_font_readiness','Check fonts on an owned exact draft revision, optionally with actual sample input. Readiness is separate from saved status; inspect issues, remedy and occurrences.',{templateId:id,expectedRevision:z.number().int().positive(),sampleRequest:json.optional()},({templateId,...a})=>call('/authoring/drafts/'+templateId+'/font-readiness','POST',a),true);
 tool('clone_template_draft','Create an owned copy from a server-verified source revision, preserving exact retained retired-font tuples. Client JSON alone grants no retained rights.',{templateId:id,sourceRevision:z.number().int().positive(),name:z.string().min(1).max(200),docKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),idempotencyKey:key},({templateId,...a})=>call('/authoring/drafts/'+templateId+'/clone','POST',a));
 tool('create_template_draft','First step: create an empty template identity and receive templateId/revision0. Does not accept a definition.',{name:z.string().min(1).max(200),docKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),idempotencyKey:key},a=>call('/authoring/drafts','POST',a));
 tool('get_template_draft','Read the owned draft and current revision.',{templateId:id},a=>call('/authoring/drafts/'+a.templateId),true);
 tool('update_template_draft','Save a complete definition with its global/section/Format schemas under an existing template ID. Use expectedRevision; never publish.',{templateId:id,expectedRevision:z.number().int().nonnegative(),definition:json,idempotencyKey:key},({templateId,...a})=>call('/authoring/drafts/'+templateId,'PUT',a));
 tool('validate_template','Validate definition and optional sample data without saving.',{definition:json,sampleRequest:json.optional()},a=>call('/authoring/validate','POST',a),true);
 tool('preview_template_draft','Queue a snapshot of an exact saved revision. Does not publish. Include uploadId in sampleRequest only for an owned finalized upload.',{templateId:id,expectedRevision:z.number().int().positive(),sampleRequest:json,idempotencyKey:key},({templateId,...a})=>call('/authoring/drafts/'+templateId+'/previews','POST',a));
 tool('get_preview_status','Read preview progress and artifact availability.',{jobId:id},a=>call('/authoring/previews/'+a.jobId),true);
 if(config.previewDirectory){
  const directory=resolve(config.previewDirectory);
  server.registerTool('save_preview_pdf',{description:'Download an owned preview PDF directly to a local file on the MCP host. Returns absolute path, byteSize and SHA-256; open that path to inspect every page. Prefer this over copying resource base64. Each call creates a separate file. Does not publish.',inputSchema:z.object({jobId:id}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},async({jobId})=>{
   let folder:string|undefined;
   try{
    const bytes:Buffer=await call('/authoring/previews/'+jobId+'/pdf','GET',undefined,true);
    if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF');
    await mkdir(directory,{recursive:true,mode:0o700});
    folder=await mkdtemp(join(directory,'preview-'));
    const path=join(folder,jobId+'.pdf');
    await writeFile(path,bytes,{flag:'wx',mode:0o600});
    return {content:[{type:'text' as const,text:JSON.stringify({ok:true,value:{path,byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'application/pdf'}})}]};
   }catch{
    if(folder){await unlink(join(folder,jobId+'.pdf')).catch(()=>{});await rmdir(folder).catch(()=>{});}
    return {content:[{type:'text' as const,text:'Preview PDF could not be saved. Check preview availability and local output-directory access, then retry.'}],isError:true};
   }
  });
 }
 server.registerTool('get_preview_pdf',{description:'Get a PDF resource link after preview succeeds. Client must support MCP resources to retrieve the binary.',inputSchema:z.object({jobId:id}).strict()},async({jobId})=>{
  try{const r=await call('/authoring/previews/'+jobId);if(!r.ok||!r.value.outputAvailable)throw Error();return {content:[{type:'resource_link',uri:`flowdoc-preview://${jobId}/pdf`,name:`preview-${jobId}.pdf`,mimeType:'application/pdf'}]};}
  catch{return {content:[{type:'text',text:'Preview PDF is not available.'}],isError:true};}
 });
 server.registerResource('preview-pdf',new ResourceTemplate('flowdoc-preview://{jobId}/pdf',{list:undefined}),{mimeType:'application/pdf'},async(uri,{jobId})=>{
  const parsed=id.parse(jobId),bytes=await call('/authoring/previews/'+parsed+'/pdf','GET',undefined,true);
  return {contents:[{uri:uri.href,mimeType:'application/pdf',blob:bytes.toString('base64')}]};
 });
 tool('create_preview_upload','Create owned image upload; use a fresh upload for each changed preview. Only uploaded PNG/JPEG files, no arbitrary URL fetch.',{requestKey:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),items:z.array(z.object({key:z.string(),source:z.literal('upload'),mediaType:z.enum(['image/png','image/jpeg']),byteSize:z.number().int().positive()}).strict()).min(1)},a=>call('/authoring/uploads','POST',a));
 tool('upload_preview_image','Send bounded image base64 using resourceId returned by create_preview_upload.',{uploadId:id,resourceId:id,data:z.string().max(2097152)},({uploadId,resourceId,data})=>call(`/authoring/uploads/${uploadId}/items/${resourceId}/base64`,'PUT',{data}));
 tool('finalize_preview_upload','Finalize owned upload before referencing its resources in sample data.',{uploadId:id},a=>call('/authoring/uploads/'+a.uploadId+'/finalize','POST'));
 return server;
}
