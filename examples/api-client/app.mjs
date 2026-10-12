import {createClient,describeFailure} from './client.mjs';
const $=id=>document.getElementById(id),client=createClient(),jobs=new Map();
let files=[],batch=[],busy=false;
const errorText=e=>[describeFailure(e),e.status?'HTTP '+e.status:'',e.code??e.message,e.details?JSON.stringify(e.details,null,2):''].filter(Boolean).join('\n');
const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
function controls(){ $('prepare').disabled=busy;$('submit').disabled=busy||!batch.some(r=>r.request&&!r.attempted); }
function row(label){
 const root=element('article',undefined,'job'),title=element('h3',label),id=element('p','ยังไม่มีรหัสงาน','muted'),status=element('p','รอเตรียมข้อมูล','status'),error=element('pre','','error'),details=element('details'),summary=element('summary','ข้อมูลสถานะจาก API'),raw=element('pre'),actions=element('div',undefined,'actions'),download=element('button','ดาวน์โหลด PDF'),resume=element('button','ติดตามอีกครั้ง');
 details.append(summary,raw);download.hidden=true;resume.hidden=true;actions.append(download,resume);root.append(title,id,status,error,actions,details);$('jobs').append(root);
 const r={root,id,status,error,raw,download,resume,attempted:false};
 resume.onclick=()=>monitor(r);download.onclick=async()=>{
  download.disabled=true;r.error.textContent='';
  try{const blob=await client.download(r.jobId),url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=r.jobId+'.pdf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='ดาวน์โหลดแล้ว — เก็บไฟล์ไว้ก่อนหมดอายุ';download.hidden=true;}
  catch(e){r.error.textContent=errorText(e);if(e.code==='OUTPUT_GONE')download.hidden=true;}
  finally{download.disabled=false;}
 };return r;
}
function show(r,job){
 r.raw.textContent=JSON.stringify(job,null,2);const names={queued:'รอคิว',running:'กำลังทำงาน',succeeded:'สร้างสำเร็จ',failed:'งานล้มเหลว'};
 const p=job.processing;r.status.textContent=(names[job.status]??job.status)+(p?' · '+p.stage+(Number.isFinite(p.completed)&&Number.isFinite(p.total)?' '+p.completed+'/'+p.total:''):'');
 if(job.warnings?.length)r.status.textContent+=' · คำเตือน '+job.warnings.length+' รายการ (ดูรายละเอียด API)';
 r.status.className='status '+(job.status==='failed'?'error':job.status==='succeeded'?'success':'');
 if(job.errors?.length)r.error.textContent=job.errors.map(e=>describeFailure(e)+'\n'+JSON.stringify(e)).join('\n');
 r.download.hidden=!job.outputAvailable;
 if(job.status==='succeeded'&&!job.outputAvailable)r.status.textContent+=' · ไฟล์ไม่มีให้ดาวน์โหลดแล้ว';
}
async function monitor(r){
 if(r.monitoring)return;r.monitoring=true;r.resume.hidden=true;r.error.textContent='';
 try{await client.watch(r.jobId,job=>show(r,job));}catch(e){r.error.textContent=errorText(e);r.resume.hidden=false;}finally{r.monitoring=false;}
}
$('health').onclick=async()=>{try{await client.health();$('connection').textContent='เชื่อมต่อแล้ว · API พร้อมรับงาน';}catch(e){$('connection').textContent=errorText(e);}};
$('json-file').onchange=async e=>{try{const file=e.target.files[0];if(file){if(file.size>2097152)throw Error('JSON เกิน 2 MiB');$('request').value=await file.text();}}catch(e){$('notice').textContent=e.message;}};
$('images').onchange=e=>{
 files=Array.from(e.target.files).map(file=>({file,key:file.name.replace(/\.[^.]+$/,'')}));$('files').replaceChildren();
 for(const f of files){const line=element('label',undefined,'file'),name=element('span',f.file.name),key=element('input');key.value=f.key;key.setAttribute('aria-label','ชื่ออ้างอิง '+f.file.name);key.oninput=()=>f.key=key.value;line.append(name,key);$('files').append(line);}
};
$('prepare').onclick=async()=>{
 busy=true;controls();$('notice').textContent='';batch=[];
 try{
  const input=JSON.parse($('request').value),selected=files.map(f=>({...f})),count=Number($('count').value);
  if(count>1&&input.uploadId&&!selected.length)throw Error('การทดสอบหลายงานต้องเลือกไฟล์รูปเพื่อสร้าง uploadId แยกกัน มิฉะนั้นระบบอาจคืนงานเดิม');
  for(let i=0;i<count;i++){
   const r=row('คำขอ '+(i+1)+' / '+count);batch.push(r);
   try{const prepared=await client.prepare(input,selected,p=>{r.status.textContent=p.stage+(p.total!==undefined?' '+p.completed+'/'+p.total:'');});r.request=prepared.request;$('contract').textContent=JSON.stringify(prepared.contract,null,2);r.raw.textContent=JSON.stringify({docKey:r.request.docKey,version:r.request.version,uploadId:r.request.uploadId});}
   catch(e){r.error.textContent=errorText(e);r.status.textContent='เตรียมไม่สำเร็จ';break;}
  }
  $('notice').textContent='เตรียมได้ '+batch.filter(r=>r.request).length+' งาน — ใช้ข้อมูล ณ ตอนกดเตรียม การแก้ช่องข้อมูลไม่เปลี่ยนชุดนี้';
 }catch(e){$('notice').textContent=e.message;}finally{busy=false;controls();}
};
$('submit').onclick=async()=>{
 busy=true;controls();
 await Promise.all(batch.filter(r=>r.request&&!r.attempted).map(async r=>{
  r.attempted=true;r.status.textContent='กำลังส่งคำขอ';
  try{const receipt=await client.submit(r.request);r.jobId=receipt.jobId;r.id.textContent=receipt.jobId;jobs.set(r.jobId,r);show(r,receipt);void monitor(r);}
  catch(e){r.status.textContent='ส่งไม่สำเร็จ';r.error.textContent=errorText(e);}
  finally{delete r.request;}
 }));busy=false;controls();
};
$('resume-form').onsubmit=e=>{
 e.preventDefault();const id=$('resume-id').value.trim();if(!id)return;const r=jobs.get(id)??row('ติดตามงานเดิม');r.jobId=id;r.id.textContent=id;jobs.set(id,r);void monitor(r);
};
