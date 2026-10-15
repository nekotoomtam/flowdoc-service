// Public-API-only client. Also exercised headlessly; no Core or database imports.
export function bindImages(input,contract,ids){
 const result=structuredClone(input);
 function visit(value,schema){
  if(schema?.type==='image')return ids.get(value)??value;
  if(schema?.type==='array'&&Array.isArray(value))return value.map(v=>visit(v,schema.items));
  if(schema?.type==='area'&&Array.isArray(value))return value.map(v=>{
   const format=Object.values(contract.areaFormats??{}).find(f=>f.ownerAreaId===schema.areaId&&f.key===v?.format);
   return v&&typeof v==='object'?{...v,data:visit(v.data,format?.inputSchema)}:v;
  });
  if(schema?.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
   for(const [key,field] of Object.entries(schema.fields??{}))if(Object.hasOwn(value,key))value[key]=visit(value[key],field);
  }
  return value;
 }
 result.data=visit(result.data,contract.globalSchema);
 for(const [key,section] of Object.entries(result.sections??{})){
  const scope=Object.hasOwn(contract.sections??{},key)?contract.sections[key]:undefined;
  if(!scope||!section||typeof section!=='object')continue;
  section.data=visit(section.data,scope.inputSchema);section.header=visit(section.header,scope.header);section.footer=visit(section.footer,scope.footer);
 }
 return result;
}
export function describeFailure(error){
 return ({QUEUE_FULL:'คิวเต็ม ยังไม่รับงานนี้ รอแล้วกดส่งใหม่ได้',UNAVAILABLE:'ระบบยังไม่พร้อม เก็บข้อมูลไว้แล้วลองใหม่ภายหลัง',UPLOAD_BUSY:'ช่องอัปโหลดเต็ม รอแล้วเตรียมข้อมูลใหม่',UPLOAD_GONE:'ข้อมูลอัปโหลดหมดอายุ ต้องเตรียมรูปใหม่',OUTPUT_GONE:'ไฟล์หมดอายุหรือถูกดาวน์โหลดไปแล้ว',PROCESS_INTERRUPTED:'ระบบหยุดระหว่างทำงาน งานนี้ล้มเหลว ต้องเตรียมและส่งงานใหม่',CONNECTION_LOST:error.ambiguous?'การเชื่อมต่อขาด ไม่ทราบว่าระบบรับคำขอแล้วหรือไม่ จึงไม่ส่งซ้ำอัตโนมัติ':'การเชื่อมต่อขาด กดติดตามงานเดิมอีกครั้งได้',MONITOR_PAUSED:'หยุดติดตามในหน้านี้ งานบนระบบยังทำต่อ ใช้รหัสงานเพื่อติดตามใหม่'}[error.code])??'ตรวจรหัสข้อผิดพลาดและตำแหน่งข้อมูลด้านล่าง';
}
export function createClient({fetcher=globalThis.fetch,prefix='/api',pollMs=1000,monitorMs=600000}={}){
 async function raw(path,method='GET',body,binary=false){
  let response;
  try{response=await fetcher(prefix+path,{method,headers:body===undefined?{}:{'content-type':binary?'application/octet-stream':'application/json'},...(body===undefined?{}:{body:binary?body:JSON.stringify(body)}),signal:AbortSignal.timeout(binary?600000:60000)});}
  catch{throw Object.assign(new Error('Connection lost'),{code:'CONNECTION_LOST',ambiguous:method!=='GET'});}
  if(!response.ok){let details;try{details=await response.json();}catch{details={};}
   throw Object.assign(new Error('API request failed'),{status:response.status,code:details.issues?.[0]?.code??'HTTP_ERROR',ambiguous:details.issues?.[0]?.code==='CONNECTION_LOST'&&method!=='GET',details});}
  return response;
 }
 async function call(path,method='GET',body,binary=false){
  const response=await raw(path,method,body,binary);let data;
  try{data=await response.json();}catch{throw Object.assign(new Error('Incomplete response'),{code:'CONNECTION_LOST',ambiguous:method!=='GET'});}
  if(!data.ok)throw Object.assign(new Error('Invalid API response'),{code:data.issues?.[0]?.code??'INVALID_RESPONSE',details:data});return data.value;
 }
 return {
  health:()=>call('/health'),
  contract:(key,version)=>call('/templates/'+encodeURIComponent(key)+'/contract'+(version===undefined?'':'?version='+encodeURIComponent(version))),
  async prepare(input,files=[],notify=()=>{}){
   if(!input||typeof input.docKey!=='string')throw Error('JSON ต้องมี docKey');
   const keys=new Set();for(const f of files){if(!/^[A-Za-z0-9_-]{1,128}$/.test(f.key)||keys.has(f.key)||!['image/png','image/jpeg'].includes(f.file.type)||!f.file.size)throw Error('ตรวจชื่ออ้างอิงรูป: ต้องไม่ซ้ำ ใช้ a-z, 0-9, _ หรือ - และเลือก PNG/JPEG ที่มีข้อมูล');keys.add(f.key);}
   notify({stage:'อ่าน Contract'});const contract=await this.contract(input.docKey,input.version);
   let request=structuredClone(input),upload;
   if(files.length){
    notify({stage:'สร้างชุดอัปโหลด'});upload=await call('/uploads','POST',{requestKey:crypto.randomUUID(),items:files.map(f=>({key:f.key,source:'upload',mediaType:f.file.type,byteSize:f.file.size}))});
    const ids=new Map(upload.items.map(i=>[i.key,i.resourceId]));
    for(const [i,f] of files.entries()){notify({stage:'กำลังอัปโหลด',completed:i,total:files.length});await call('/uploads/'+encodeURIComponent(upload.uploadId)+'/items/'+encodeURIComponent(ids.get(f.key))+'/content','PUT',f.file,true);}
    notify({stage:'ยืนยันชุดอัปโหลด',completed:files.length,total:files.length});await call('/uploads/'+encodeURIComponent(upload.uploadId)+'/finalize','POST',{});
    request=bindImages(input,contract,ids);request.uploadId=upload.uploadId;
   }
   request.version=contract.version;notify({stage:'พร้อมส่ง'});return {request,contract,upload};
  },
  submit:request=>call('/jobs','POST',request),
  status:id=>call('/jobs/'+encodeURIComponent(id)),
  async watch(id,notify=()=>{},signal){
   const started=Date.now();
   while(!signal?.aborted&&Date.now()-started<monitorMs){const job=await this.status(id);notify(job);if(['succeeded','failed'].includes(job.status))return job;await new Promise(r=>setTimeout(r,pollMs));}
   throw Object.assign(new Error('Monitoring paused'),{code:'MONITOR_PAUSED'});
  },
  async download(id){const response=await raw('/jobs/'+encodeURIComponent(id)+'/pdf');try{return await response.blob();}catch{throw Object.assign(new Error('Download interrupted'),{code:'CONNECTION_LOST',ambiguous:false});}}
 };
}
