import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createTaskIntake} from '../dist/tasks/intake.js';
import {createTaskProcessing} from '../dist/tasks/processing.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
export const auth='Bearer '+'d'.repeat(40),sid='10000000-0000-4000-8000-000000000011',contentType='multipart/form-data; boundary=docx-fixture';
export function template(){
 const t=JSON.parse(readFileSync('examples/area-document-template.json','utf8'));t.templateId=t.docKey='docx-small';t.nodeModelVersion=19;t.examples=[];t.globalSchema={type:'object',fields:{}};
 const text={id:'text',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'leaf',type:'field-ref',scope:'local',key:'text'}]},photo={id:'photo',type:'image',props:{width:{value:100,unit:'pt'},height:{value:50,unit:'pt'},source:{scope:'local',key:'photo'}}};
 t.areaFormats={item:{key:'item',ownerAreaId:'parts',inputSchema:{type:'object',fields:{text:{type:'string',required:true},photo:{type:'image'}}},repeats:[],fragment:{rootIds:['text','photo'],nodes:{text,photo}}}};
 t.sections=[{id:sid,label:'Small1',nameBase:'Small',inputSchema:{type:'object',fields:{parts:{type:'area',areaId:'parts'}}},source:{kind:'authored',repeats:[],fragment:{rootIds:['parts'],nodes:{parts:{id:'parts',type:'area',props:{areaId:'parts'}}}}}}];return t;
}
const part=(name,b,type)=>Buffer.concat([Buffer.from('--docx-fixture\r\nContent-Disposition: form-data; name="'+name+'"\r\nContent-Type: '+type+'\r\n\r\n'),Buffer.from(b),Buffer.from('\r\n')]);
export async function body(images=0,text='ไทย EN'){
 const rows=Array.from({length:Math.max(1,images)},(_,i)=>({format:'item',data:{text:text+' '+i,...(images?{photo:{image:{upload:true}}}:{})}})),parts=[part('payload',JSON.stringify({data:{},sections:[{id:sid,data:{parts:rows}}]}),'application/json')];
 for(let i=0;i<images;i++){const png=i%2===1,b=await sharp({create:{width:20,height:10,channels:4,background:{r:120,g:80,b:160,alpha:png?0.4:1}}})[png?'png':'jpeg']().toBuffer();parts.push(part('/sections/0/data/parts/'+i+'/data/photo/image',b,png?'image/png':'image/jpeg'));}
 return Buffer.concat([...parts,Buffer.from('--docx-fixture--\r\n')]);
}
export function response(){const parts=[];return{parts,start(){},async write(b){parts.push(Buffer.from(b));},async end(){},async abort(){}};}
export function artifact(parts){const all=Buffer.concat(parts),at=all.indexOf(Buffer.from('Content-Disposition: attachment;'));if(at<0)throw Error(all.toString());const end=all.indexOf(Buffer.from('\r\n\r\n'),at),headers=all.subarray(all.lastIndexOf(Buffer.from('--flowdoc-'),at),end).toString(),length=Number(headers.match(/Content-Length: (\d+)/)[1]);return {bytes:all.subarray(end+4,end+4+length),headers};}
export function fixture(){
 const db=isolatedDatabase(),pool=db.pool;let intake,manager,processor,app,root;
 const identity=h=>h===auth?{ownerKey:'owner',principalId:'creator',taskRead:true,docKeys:['docx-small']}:null;
 async function close(){await app?.close();await manager?.stop();await processor?.stop();await intake?.stop();app=manager=processor=intake=undefined;}
 return {pool,db,get intake(){return intake;},get manager(){return manager;},get root(){return root;},
  async setup(){await db.setup();const m=await migrate(pool);if(!m.ok)throw Error(JSON.stringify(m));const t=await registerTemplate(pool,JSON.stringify(template()));if(!t.ok)throw Error(JSON.stringify(t));},
  async reset({processing={},...overrides}={}){await close();root=await mkdtemp(join(tmpdir(),'service-docx-'));intake=await createTaskIntake({pool,root,resolveCredential:identity,freeBytes:async()=>20_000_000_000,...overrides});manager=await createTaskProcessing({pool,intake,workerReady:()=>processor?.isReady()??false,...processing});processor=await startProcessor({pool,tasks:manager,files:{writePdf:async()=>{throw Error('legacy forbidden');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:5});},
  async task(format='docx',images=1,queueMode=false,text){const t=await intake.open({authorization:auth,docKey:'docx-small',contentType,outputFormat:format,queueMode});await intake.receive({authorization:auth,taskId:t.taskId,contentType,body:Readable.from([await body(images,text)])});await intake.normalize({authorization:auth,taskId:t.taskId});return t.taskId;},
  async server(){app=createServer({pool,outputs:{},isReady:()=>true,tasks:{intake,processing:manager}});return app.listen({host:'127.0.0.1',port:0});},
  async save(name,b){if(process.env.FLOWDOC_TASK_PROOF_DIR)await writeFile(join(process.env.FLOWDOC_TASK_PROOF_DIR,name),b);},
  async close(){await close();await db.close();}
 };
}
