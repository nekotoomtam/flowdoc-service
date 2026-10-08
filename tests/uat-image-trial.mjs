// Runnable synthetic UAT acceptance fixture; no historical customer data or URLs.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,readdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {loadBundledResources} from '@flowdoc/core';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
import {registerTemplate} from '../dist/templates/registry.js';
import {createResourceFiles} from '../dist/storage/resource-files.js';
import {createUploads} from '../dist/uploads/service.js';
import {readUploadConfig} from '../dist/uploads/config.js';
import {createPdfFiles} from '../dist/storage/pdf-files.js';
import {createOutputs} from '../dist/storage/outputs.js';
import {startProcessor} from '../dist/jobs/processor.js';
import {createServer} from '../dist/http/server.js';
const output=process.env.FLOWDOC_UAT_OUTPUT??'/tmp/uat-output';await mkdir(output,{recursive:true});
const db=isolatedDatabase(),ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};let app,processor,u;
try{
 await db.setup();ok(await migrate(db.pool));const root=await mkdtemp(join(tmpdir(),'uat-live-'));
 const bundled=ok(await loadBundledResources({pythonExecutable:'python',tempRoot:root}));
 const fontConfig=join(root,'fonts.conf');await writeFile(fontConfig,`<fontconfig><dir>${dirname(bundled.fonts[0].path)}</dir><cachedir>${root}/font-cache</cachedir></fontconfig>`);process.env.FONTCONFIG_FILE=fontConfig;
 const t=JSON.parse(await readFile('examples/srs-template.json','utf8'));t.templateId=t.docKey='uat-image-trial';t.name='Mock UAT image report';t.nodeModelVersion=5;t.globalSchema={type:'object',fields:{}};t.examples=[];
 t.formats={note:{inputSchema:{type:'object',fields:{text:{type:'string',required:true}}},fragment:{rootIds:['note'],nodes:{note:{id:'note',type:'text-block',role:{role:'paragraph'},props:{textStyleId:'body'},children:[{id:'value',type:'field-ref',scope:'local',key:'text'}]}}},repeats:[]}};
 for(const [name,w,h] of [['screen',470,265],['small',235,133],['portrait',235,400]])t.formats[name]={inputSchema:{type:'object',fields:{image:{type:'image',required:true}}},fragment:{rootIds:['image'],nodes:{image:{id:'image',type:'image',props:{width:{value:w,unit:'pt'},height:{value:h,unit:'pt'},source:{scope:'local',key:'image'}}}}},repeats:[]};
 ok(await registerTemplate(db.pool,JSON.stringify(t)));
 const svg=(portrait=false)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${portrait?1200:3840}" height="${portrait?2000:2160}" viewBox="0 0 ${portrait?1200:1920} ${portrait?2000:1080}"><rect width="100%" height="100%" fill="#eef2f7"/><rect width="100%" height="130" fill="#15394e"/><g font-family="sans-serif" fill="#16364a"><text x="65" y="85" fill="white" font-size="44">UAT / Document request</text><rect x="50" y="180" width="${portrait?1100:1820}" height="740" rx="20" fill="white"/><text x="90" y="270" font-size="42">REQ-001 | Create request</text><text x="90" y="355" font-size="36">Project: FlowDoc sample</text><text x="90" y="440" font-size="36">Document: Acceptance report</text><text x="90" y="525" font-size="36">Owner: Test user</text><text x="90" y="610" font-size="36">Status: Ready for review</text><rect x="90" y="710" width="440" height="110" rx="12" fill="#10766e"/><text x="160" y="782" font-size="36" fill="white">Confirm request</text><text x="65" y="1010" font-size="30">Synthetic test data — no customer information</text></g></svg>`;
 const bytes=[await sharp(Buffer.from(svg())).jpeg({quality:95}).toBuffer(),await sharp(Buffer.from(svg(true))).png().toBuffer(),await sharp({create:{width:800,height:300,channels:4,background:{r:0,g:128,b:100,alpha:0.4}}}).png().toBuffer()];
 const files=await createResourceFiles(join(root,'staging')),config=readUploadConfig({});u=createUploads({pool:db.pool,files,config});const pdfFiles=await createPdfFiles(join(root,'pdf'));
 processor=await startProcessor({pool:db.pool,files:pdfFiles,policy:{retain:true,ttlHours:24,tempHours:24},resources:{files,config}});
 app=createServer({pool:db.pool,uploads:u,outputs:createOutputs(db.pool,pdfFiles,24),isReady:processor.isReady,imagesEnabled:true});const url=await app.listen({host:'127.0.0.1',port:0});
 const json=async(path,body)=>{const r=await fetch(url+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return ok(await r.json());};
 const set=await json('/uploads',{requestKey:'uat-live',items:bytes.map((b,i)=>({key:'image'+i,source:'upload',mediaType:i===0?'image/jpeg':'image/png',byteSize:b.length}))});
 for(let i=0;i<bytes.length;i++){const item=set.items.find(x=>x.key==='image'+i);const r=await fetch(url+`/uploads/${set.uploadId}/items/${item.resourceId}/content`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes[i]});assert.equal(r.status,200);}
 await json(`/uploads/${set.uploadId}/finalize`,{});const ids=[0,1,2].map(i=>set.items.find(x=>x.key==='image'+i).resourceId);
 const note=text=>({format:'note',data:{text}}),image=(i,format='screen')=>({format,data:{image:ids[i]}});
 const request={docKey:t.docKey,uploadId:set.uploadId,data:{},content:[note('รายงานทดสอบ UAT — ชุดจำลองภาพประกอบ\nกรณี UAT-001: สร้างคำขอเอกสาร\nขั้นตอน: กรอกข้อมูลโครงการ เลือกประเภทเอกสาร และกดยืนยัน\nผลที่คาดหวัง: ระบบบันทึกข้อมูลและแสดงสถานะพร้อมตรวจสอบ\nรูปภาพที่เกี่ยวข้อง: หน้าจอแนวนอน ต้นฉบับ 3840 × 2160'),image(0),note('ภาพเดิมในกรอบเล็ก: ใช้ตรวจการเตรียมภาพตามขนาดกรอบ'),image(0,'small'),note('กรณี UAT-002: ตรวจหน้าจอแนวตั้ง\nผลที่คาดหวัง: สัดส่วนภาพไม่ผิดเพี้ยนและกรอบไม่ถูกตัดเมื่อข้ามหน้า'),image(1,'portrait'),note('กรณี UAT-003: PNG โปร่งใส\nผลที่คาดหวัง: สีและความโปร่งใสถูกเก็บไว้ใน PDF'),image(2,'small')]};
 const job=await json('/jobs',request),stages=[];let view;
 for(let n=0;n<1200;n++){view=await json('/jobs/'+job.jobId);if(view.processing)stages.push(view.processing);if(['failed','succeeded'].includes(view.status))break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(view.status,'succeeded',JSON.stringify(view));const pdf=await fetch(url+view.downloadUrl);assert.equal(pdf.status,200);await writeFile(join(output,'uat-image-trial.pdf'),Buffer.from(await pdf.arrayBuffer()));
 const derivatives=[];for(const name of await readdir(files.jobDirectory(job.jobId))){if(!/\.(jpg|png)$/.test(name))continue;const m=await sharp(join(files.jobDirectory(job.jobId),name)).metadata();derivatives.push({format:m.format,width:m.width,height:m.height,alpha:m.hasAlpha});}
 assert.equal(derivatives.length,4);assert.ok(derivatives.some(i=>i.format==='jpeg'&&i.width<3840));
 const report={status:'PASS',jobId:job.jobId,checks:['live HTTP upload/finalize/job/poll/download','4K screenshot downsample','same source at two frame sizes','portrait and alpha PNG','synthetic UAT report'],stages,derivatives,warnings:view.warnings};
 await writeFile(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app?.close();await processor?.stop();await u?.stop();await db.close();}
