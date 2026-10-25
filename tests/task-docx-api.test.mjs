import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFile,writeFile,mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createTaskIntake} from '../dist/tasks/intake.js';
import {createTaskProcessing} from '../dist/tasks/processing.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
import {stageSet} from './fontLifecycleFixture.mjs';
import {template as smallTemplate,artifact,sid} from './taskDocxFixture.mjs';
const db=isolatedDatabase(),pool=db.pool,sha=b=>createHash('sha256').update(b).digest('hex');
const token='i6-local-only-'+'a'.repeat(40),auth='Bearer '+token,proof=process.env.FLOWDOC_TASK_PROOF_DIR;
const cases={},results=[],rss={parentPeakBytes:0,workers:{},sampleMs:20};let intake,manager,processor,app,root,url,timer,sampling=false;
const ok=r=>{expect(r.ok,JSON.stringify(r)).toBe(true);return r.value;};
const part=(name,b,type)=>Buffer.concat([Buffer.from('--i6-pair\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+type+'\r\n\r\n'),Buffer.from(b),Buffer.from('\r\n')]);
async function memory(){if(sampling)return;sampling=true;try{
 const own=await readFile('/proc/self/status','utf8');rss.parentPeakBytes=Math.max(rss.parentPeakBytes,Number(own.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024);
 for(const pid of (await readdir('/proc')).filter(p=>/^\d+$/.test(p))){try{const cmd=await readFile('/proc/'+pid+'/cmdline','utf8');if(!cmd.includes('dist/tasks/render-child.js'))continue;const status=await readFile('/proc/'+pid+'/status','utf8');const n=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024;rss.workers[pid]=Math.max(rss.workers[pid]??0,n);}catch{}}
 }finally{sampling=false;}}
beforeAll(async()=>{
 expect(proof,'explicit test output root required').toBeTruthy();await db.setup();ok(await migrate(pool));root=await mkdtemp(join(tmpdir(),'i6-api-'));process.env.FONT_STORAGE_DIR=join(root,'fonts');
 const folder=process.env.I6_FONT_DIR;expect(folder,'reviewed second-font folder required').toBeTruthy();
 const files=['Regular','Bold','Italic','BoldItalic'].map(f=>join(folder,'BaiJamjuree-'+f+'.ttf'));
 const font=await stageSet(pool,process.env.FONT_STORAGE_DIR,{files,weights:[400,700,400,700]});
 // Isolated accepted-font fixture, following existing task/font pipeline tests.
 await pool.query("UPDATE font_releases SET state='active',ever_activated_at=now() WHERE id=$1",[font.id]);
 const t=smallTemplate();t.templateId=t.docKey='i6-type-images';t.schemaVersion=2;
 const faces=[[400,'normal'],[700,'normal'],[400,'italic'],[700,'italic']];t.styles={};
 t.areaFormats.item.inputSchema.fields.anchor={type:'string',required:true};
 const frag=t.areaFormats.item.fragment;frag.rootIds=frag.rootIds.filter(id=>id!=='text');delete frag.nodes.text;
 for(const [i,[weight,style]] of faces.entries()){t.styles['face'+i]={font:{kind:'library',releaseId:font.id,weight,style},fontSize:{value:12,unit:'pt'},lineHeightPt:18};const id='face'+i;frag.nodes[id]={id,type:'text-block',role:{role:'paragraph'},props:{textStyleId:id,...(i===0?{toc:{level:1},anchorId:{scope:'local',key:'anchor'}}:{})},children:[{id:id+'-leaf',type:'field-ref',scope:'local',key:'text'}]};frag.rootIds.splice(i,0,id);}
 cases.typography={template:t,input:{data:{},sections:[{id:sid,data:{parts:[{format:'item',data:{text:'ไทย EN\nกุ้ง two',photo:{image:{upload:true}}}},{format:'item',data:{text:'ปี่ ABC\nน้ำ three',photo:{image:{upload:true}}}}]}}]},images:[]};
 cases.typography.input.sections[0].data.parts.forEach((part,i)=>{part.data.anchor='i6-heading-'+i;});
 for(let i=0;i<2;i++){const type=i?'image/png':'image/jpeg',bytes=await sharp({create:{width:32,height:16,channels:4,background:{r:40,g:120,b:190,alpha:i?0.4:1}}})[i?'png':'jpeg']().toBuffer();cases.typography.images.push({pointer:'/sections/0/data/parts/'+i+'/data/photo/image',type,bytes});}
 const merged=JSON.parse(await readFile('tests/fixtures/docx-i6/merged-template.json','utf8'));merged.templateId=merged.docKey='i6-merged';
 cases.merged={template:merged,input:{data:{text:'ไทย EN\nบรรทัด two'},sections:{main:{data:{details:[{format:'merged',data:{}}]}}}},images:[]};
 const navigationInput=JSON.parse(await readFile('tests/fixtures/docx-i6/navigation-request.json','utf8'));
 cases.navigation={template:JSON.parse(await readFile('tests/fixtures/docx-i6/navigation-template.json','utf8')),input:{data:navigationInput.data,sections:navigationInput.sections},images:[]};
 for(const [key,c] of Object.entries(cases)){ok(await registerTemplate(pool,JSON.stringify(c.template)));c.multipart=Buffer.concat([part('payload',JSON.stringify(c.input),'application/json'),...c.images.map(i=>part(i.pointer,i.bytes,i.type)),Buffer.from('--i6-pair--\r\n')]);await writeFile(join(proof,key+'-template.json'),JSON.stringify(c.template,null,2));await writeFile(join(proof,key+'-request.json'),JSON.stringify(c.input,null,2));}
 intake=await createTaskIntake({pool,root:join(root,'tasks'),resolveCredential:h=>h===auth?{ownerKey:'i6',principalId:'tester',taskRead:true,docKeys:Object.values(cases).map(c=>c.template.docKey)}:null,freeBytes:async()=>20_000_000_000});
 manager=await createTaskProcessing({pool,intake,workerReady:()=>processor?.isReady()??false});processor=await startProcessor({pool,tasks:manager,files:{writePdf:async()=>{throw Error('Unexpected legacy route');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:5});
 app=createServer({pool,outputs:{},isReady:()=>processor.isReady(),tasks:{intake,processing:manager}});url=await app.listen({host:'127.0.0.1',port:0});timer=setInterval(()=>void memory(),rss.sampleMs);
 await writeFile(join(proof,'font-inputs.json'),JSON.stringify(await Promise.all(files.map(async p=>({name:p.split('/').at(-1),sha256:sha(await readFile(p))}))),null,2));
},60000);
afterAll(async()=>{clearInterval(timer);await app?.close();await manager?.stop();await processor?.stop();await intake?.stop();await memory();if(proof){await writeFile(join(proof,'service-pairs.json'),JSON.stringify(results,null,2));await writeFile(join(proof,'rss.json'),JSON.stringify({...rss,measurement:'sampled Linux VmRSS; parent is actual test-process Service manager, workers are separate render children; file size is not RSS',workerPeakBytes:Math.max(0,...Object.values(rss.workers))},null,2));}delete process.env.FONT_STORAGE_DIR;await db.close();});
for(const name of ['typography','merged','navigation'])for(const queue of [false,true])it.each([undefined,'PDF','DOCX'])('paired '+name+' queue='+queue+' format=%s',async requested=>{
 const c=cases[name],format=requested==='DOCX'?'docx':'pdf',r=await fetch(url+'/documents',{method:'POST',headers:{authorization:auth,'doc-key':c.template.docKey,'content-type':'multipart/form-data; boundary=i6-pair',...(requested?{'output-format':requested}:{}),...(queue?{'task-mode':'queue-v1'}:{})},body:c.multipart});expect(r.status).toBe(200);
 const all=Buffer.from(await r.arrayBuffer()),file=artifact([all]);expect(file.headers).toContain('filename="document.'+format+'"');expect(file.bytes.subarray(0,format==='pdf'?5:2).toString()).toBe(format==='pdf'?'%PDF-':'PK');
 const taskId=all.toString().match(/"taskId":"([^"]+)"/)?.[1];expect(taskId).toBeTruthy();let task;for(let n=0;n<100;n++){task=await intake.inspect(auth,taskId);if(task.status==='succeeded')break;await new Promise(r=>setTimeout(r,10));}expect(task.status).toBe('succeeded');expect(task.outputFormat).toBe(format);
 const job=(await pool.query('SELECT * FROM generation_jobs WHERE task_id=$1',[taskId])).rows[0],stored=(await pool.query('SELECT * FROM document_outputs WHERE job_id=$1',[job.id])).rows[0];expect(stored.sha256).toBe(sha(file.bytes));expect(stored.output_format).toBe(format);expect(format==='docx'?stored.page_count===null:Number(stored.page_count)>0).toBe(true);
 const originals=(await pool.query("SELECT id,logical_path,checksum,received_bytes,media_type FROM task_files WHERE task_id=$1 AND role='original_image' ORDER BY part_order",[taskId])).rows;expect(originals).toHaveLength(c.images.length);for(const [i,img] of c.images.entries()){expect(originals[i].checksum).toBe(sha(img.bytes));expect(originals[i].media_type).toBe(img.type);}
 const key=name+'-'+(queue?'queue':'normal')+'-'+(requested??'default');await writeFile(join(proof,key+'.'+format),file.bytes);
 results.push({name,key,requested:requested??null,format,queue,taskId,jobId:job.id,templateSha256:sha(JSON.stringify(c.template)),businessInputSha256:sha(JSON.stringify(c.input)),rawMultipartSha256:sha(c.multipart),preparedInputSha256:sha(JSON.stringify(job.prepared_input)),originalInput:job.original_input,originalImages:originals,artifact:{sha256:sha(file.bytes),bytes:file.bytes.length,pageCount:stored.page_count},resourceIdPolicy:'Per-task image IDs are retained individually; raw business input and original-image hashes must match, no output/layout normalization.'});
},30000);
