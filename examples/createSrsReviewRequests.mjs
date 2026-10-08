// Repository-owned deterministic SRS review data; fictional requirements, no production data.
// Validates through the shipped Core contract; does not change templates or layout.
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validateTemplate,prepareGeneration} from '@flowdoc/core';
const target=resolve(process.argv[2]??'artifacts/r5-long-review');mkdirSync(target,{recursive:true});
const template=validateTemplate(readFileSync(new URL('./srs-template.json',import.meta.url),'utf8'));if(!template.ok)throw Error(JSON.stringify(template));
const topics=[
 ['รับคำขอเอกสาร','ระบบรับข้อมูลผู้ขอ ชื่อโครงการ และรายการเอกสาร ตรวจสอบช่องบังคับก่อนบันทึก หากพบข้อมูลไม่ครบต้องแจ้งชื่อช่องและตำแหน่งรายการทั้งหมดโดยไม่สร้างงานซ้ำ'],
 ['ค้นหาและกรองรายการ','ผู้ใช้งานค้นหาด้วยรหัส ชื่อเรื่อง ช่วงวันที่ และสถานะร่วมกันได้ ผลลัพธ์ต้องเรียงตามเงื่อนไขเดียวกันทุกครั้ง และแสดงข้อความอธิบายเมื่อไม่พบรายการที่ตรงกัน'],
 ['ตรวจสอบข้อมูลนำเข้า','ข้อมูลภาษาไทย ภาษาอังกฤษ ตัวเลข และเครื่องหมายต้องคงตามที่ส่งมา ค่าว่างกับข้อมูลที่ไม่ส่งต้องได้รับการตรวจแยกกัน และไม่เปลี่ยนค่าผิดประเภทเป็นค่าเริ่มต้นโดยไม่แจ้ง'],
 ['บันทึกฉบับร่าง','เมื่อแก้ไขเนื้อหาต้องบันทึกเฉพาะฉบับปัจจุบัน การบันทึกพร้อมกันต้องตรวจลำดับการแก้ไข หากข้อมูลเปลี่ยนไปแล้วต้องแจ้งให้โหลดข้อมูลล่าสุดแทนการเขียนทับโดยเงียบ'],
 ['สร้างรุ่นเอกสาร','ก่อนสร้างรุ่นต้องตรวจโครงสร้าง ตัวแปร และตัวอย่างทั้งหมด รุ่นใหม่อ้างถึงเอกสารเดิมแต่มีข้อมูลของตนเอง การแก้ไขภายหลังต้องไม่เปลี่ยนเอกสารรุ่นที่เผยแพร่แล้ว'],
 ['จัดคิวประมวลผล','เมื่อรับงานสำเร็จต้องคืนรหัสติดตามและเวอร์ชันที่เลือก งานที่รอประมวลผลต้องไม่สูญหายเมื่อเปิดระบบใหม่ และผลลัพธ์ของแต่ละคำขอต้องไม่ปนกับคำขออื่น'],
 ['จัดหน้าตาราง','ตารางต้องแสดงข้อมูลตามลำดับเดิม หัวตารางปรากฏซ้ำบนหน้าถัดไปเมื่อจำเป็น รายการที่มีรายละเอียดมากต้องต่อเนื่องข้ามหน้าโดยไม่ทำข้อความส่วนต้นหรือส่วนท้ายหาย'],
 ['ส่งมอบผลลัพธ์','ผู้เรียกตรวจสถานะก่อนรับเอกสารได้ การส่งที่ขาดช่วงต้องไม่ถูกนับว่าส่งเสร็จ ไฟล์ชั่วคราวต้องได้รับการจัดการตามนโยบายโดยไม่ลบระหว่างที่ยังใช้งานอยู่']
];
const note=text=>({format:'section-note',data:{text}}),table=items=>({format:'requirement-list',data:{items}});
const row=n=>{const [title,detail]=topics[(n-1)%topics.length];const key='REQ-'+String(n).padStart(3,'0');return {code:key,detail:`[${key}-BEGIN] หัวข้อ ${title}\n${detail}\nเกณฑ์ตรวจรับ: ทดลองข้อมูลที่ถูกต้อง ข้อมูลไม่ครบ และการเรียกซ้ำ ตรวจสอบว่ารายการลำดับ ${n} แสดงคำตอบตามเงื่อนไข และยังอ้างอิงข้อมูลต้นฉบับได้ครบถ้วน โดยผู้ทดสอบบันทึกผลที่เกิดขึ้นจริงพร้อมเหตุผลของรายการที่ไม่ผ่าน [${key}-END]`,remark:`ตรวจรับรายการ ${n}\nผู้ทดสอบจำลอง\nผล: รอตรวจ`};};
const envelope=(name,content)=>({docKey:'srs-table-trial',version:1,data:{projectName:name},content});
const normal=envelope('SRS ข้อมูลจำลอง - กรณีปกติ',[note('[NORMAL-BEGIN] ข้อกำหนดจำลองสำหรับตรวจรูปแบบเอกสาร ไม่ใช่ข้อกำหนดผลิตภัณฑ์ที่อนุมัติแล้ว'),table([row(1),row(2),row(3)]),note('[NORMAL-END] ตรวจข้อมูลครบสามรายการและข้อความหลังตาราง')]);
const empty=envelope('SRS ข้อมูลจำลอง - รายการว่าง',[note('[EMPTY-BEGIN] ตารางนี้ไม่มีข้อมูล ต้องคงหัวตารางและไม่สร้างแถวข้อมูลปลอม'),table([]),note('[EMPTY-END] ข้อความหลังตารางว่างต้องยังปรากฏ')]);
const paragraphs=Array.from({length:36},(_,i)=>{const [title,detail]=topics[i%topics.length];return `[LONG-P${String(i+1).padStart(2,'0')}] ขั้นตอนตรวจสอบ ${title}: ${detail} กรณีนี้เป็นรายละเอียดภายในรายการเดียว ผู้ทดสอบต้องอ่านต่อจากหน้าก่อนและเปรียบเทียบลำดับย่อหน้าเพื่อยืนยันว่าไม่มีข้อความซ้ำหรือข้ามลำดับ ค่าทดลองประกอบด้วยภาษาไทย English หมายเลข ${i+1} วันที่ 2026-10-08 และรหัส TEST-${String(i+1).padStart(3,'0')}.`;});
const longRow={code:'REQ-LONG',detail:'[LONG-ROW-BEGIN]\n'+paragraphs.join('\n')+'\n[LONG-ROW-END]',remark:'รายการเดียวที่ยาวเกินหนึ่งหน้า\nต้องต่อเนื่องจนจบ'};
const intro=Array.from({length:6},(_,i)=>`[INTRO-${i+1}] เอกสารนี้เป็นข้อมูลสมมติสำหรับทดสอบการจัดหน้าโดยใช้โครงเดิม เนื้อหาประกอบด้วยข้อความก่อนตาราง รายการหลายแถว รายการเดียวที่ยาวมาก และข้อความหลังตาราง การตรวจต้องดูความครบถ้วนของข้อความ การซ้ำหัวตาราง และขอบกระดาษร่วมกัน ไม่ใช้จำนวนหน้าหรือความเร็วเป็นหลักฐานว่าพร้อมรองรับโหลดจริง`).join('\n');
const long=envelope('SRS ข้อมูลจำลอง - หลายหน้าและแถวยาว',[note('[DOCUMENT-BEGIN]\n'+intro),table([row(1),row(2),row(3),row(4),longRow,...Array.from({length:28},(_,i)=>row(i+5))]),note('[DOCUMENT-END] จบข้อมูลจำลองครบ 32 รายการปกติและหนึ่งรายการยาว ตรวจว่าข้อความปิดท้ายอยู่หลังตารางจริง')]);
const manifest={source:'Fictional SRS requirements authored for deterministic pagination review; no external or customer data',template:'srs-template.json',cases:[]};
for(const [name,request] of Object.entries({normal,empty,long})){const check=prepareGeneration(template.value,request);if(!check.ok)throw Error(JSON.stringify(check));writeFileSync(join(target,name+'.request.json'),JSON.stringify(request,null,2)+'\n');const texts=[request.data.projectName,...request.content.flatMap(c=>c.format==='section-note'?[c.data.text]:c.data.items.flatMap(r=>[r.code,r.detail,r.remark??'']))];const markers=texts.flatMap(s=>[...s.matchAll(/\[([A-Z0-9-]+)\]/g)].map(m=>m[0]));manifest.cases.push({name,characters:texts.join('').length,rows:request.content.filter(c=>c.format==='requirement-list').reduce((n,c)=>n+c.data.items.length,0),markers});}
writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest.cases.map(({markers,...c})=>({...c,markers:markers.length})),null,2));
