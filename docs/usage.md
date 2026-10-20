# คู่มือใช้งาน FlowDoc Service 0.4.7

Candidate นี้มีทางประมวลผล task ภายใน (migration024) ใช้ Core0.4.7 จาก
vendor/manifest.json อ่านข้อมูลที่ normalize แล้วจากไฟล์ เตรียมภาพทีละรายการ
และส่ง feedback กับ PDF แบบ multipart โดยไม่รวม PDF ทั้งก้อนใน RAM.
ยังไม่มี public `/documents` หรือ capability ใหม่; การเชื่อม HTTP/FlowDocMake
เป็นช่วงถัดไป ตัวรับ–ส่งต้องรอ write/finish จริงและ abort ต้องปิดการส่งที่ค้าง.
ทาง task รองรับ Linux/amd64 เท่านั้นใน candidate นี้; ไม่ใช่คำอนุญาตติดตั้ง.
Container ที่รัน task ต้องมี init เก็บกวาด process ลูก: Compose ที่ให้มาตั้ง
`init: true` ให้ API, registry และ verification แล้ว หากเปิดด้วย `docker run`
โดยตรงต้องใส่ `--init` ด้วย แม้เปลี่ยน entrypoint เป็น Node. ไม่รองรับ Node เป็น
PID1 สำหรับงาน task เพราะเมื่อ worker ถูก SIGKILL อาจเหลือ zombie.
หลัง build image ทดลอง ใช้ `FLOWDOC_REGISTRY_IMAGE` ระบุ image นั้นแล้วรัน
`npm run check:process-reaping` เพื่อตรวจการหยุดปกติและบังคับฆ่า worker.
หลักการเก็บ/หยุด/ล้างไฟล์และข้อจำกัดอยู่ในหัวข้อ Internal task processing ของ README.

Candidate เซลล์ชื่อกลุ่ม: ตรวจ `groupLabelSpans.version:1` ใน authoring contract
ก่อนส่ง rowGroups.groupLabel (model19/schema1,2). Core package/checksum อยู่ใน
vendor/manifest.json; ชุดส่งมอบพัฒนาเป็น 0.4.7 และยังไม่ใช่คำอนุญาตติดตั้ง.
save/read/clone/import คง declaration; job ตรึง revision/ข้อมูล/engine/font เดิม.
auto ตรวจฟอนต์รวม ` (ต่อ)`; fixed ไม่มีหน้าต่อและส่ง FORMAT_CONTENT_OMITTED
พร้อม groupId/groupIndex/itemIndex ของส่วนค้าง. ถ้าชื่อเต็มใส่ auto ไม่ได้
ให้ LAYOUT_FAILED reason group-label-does-not-fit; ไม่มี PDF บางส่วนให้ดาวน์โหลด.

Section19 ช่วง1: candidate นี้เพิ่ม `create_draft_section` และ
`import_draft_sections` ตาม `/authoring/drafts/:id/sections[/import]`.
ต่อ/แยกสำเนาลง draft ก่อนส่งข้อมูล `sections:[{id,data,header?,footer?}]`;
ลำดับพิมพ์ตาม definition และ clone/import จัด ID ใหม่พร้อม sectionIdMap.
ต้องตรวจสิทธิ์ทั้งต้นทาง/ปลายทางและ revision; retry ใช้ key/body เดิม.
Migration021 เพิ่มประวัติ ID กันใช้ ID ที่ลบกลับมาใหม่ และขยาย job pin/ownership
สำหรับ19 โดยไม่ rewrite ข้อมูล18. Model18 ยังใช้ object input และ clone เดิม.
ช่วง2 เปิด fixed-height text ใน Area ที่วางตรง flow หลักของ Section19;
ข้อความที่กำหนด props.heightMode:fixed / props.height ต้องพอดีกรอบและ body มิฉะนั้น preview ล้มเหลว.
คนละสัญญากับ Format sizing.fixed ด้านท้ายคู่มือ ซึ่งแสดงส่วนที่พอในเพดานความสูง
min(ความสูงที่กำหนด, พื้นที่หน้าที่เหลือ) แล้วแจ้งส่วนที่ไม่แสดง โดยไม่ย่อ/ตัดกลางบรรทัด.
Section ยังคุมหน้าและหัว–ท้าย; fixed ใน cell/repeat และ Area ซ้อนยังห้าม.
ช่วง3 เปิด TOC ของ19ด้วย props.scope kind section/document ชัดเจน หนึ่งต่อขอบเขต;
clone คง scope ตาม Section เจ้าของที่ได้ ID ใหม่. เลขและลิงก์คำนวณจากหน้าเป้าหมาย
ของ pinned preview;18ยังใช้ TOC เดิมโดยไม่ใส่ scope. ยังไม่แปลง18→19อัตโนมัติ. ใช้ package/hash จาก
README และ vendor/manifest.json ปัจจุบัน; ส่วนคู่มือคลังฟอนต์ด้านล่างเก็บบริบท
คำอธิบายความสามารถเดิมไว้และไม่ใช่คำอนุญาตติดตั้งอัตโนมัติ.

## Authority Boundary

ช่วง2 เพิ่ม normalize และ findings ภายใน adapter กับ migration023: ใช้ Core
จากแพ็กเกจที่ตรึงไว้ อ่านไฟล์ทีละส่วนและคงค่า/ลำดับสมาชิก. ภาพมีหรือไม่มี assetKey
ใช้ได้; key ใช้เฉพาะ Section ของตน. ภาพหาย/เสีย/ขัดแย้งคงตัวแทนพร้อมเหตุผล
และจำนวนส่วนที่ไม่แสดง โดยไม่ทำข้อมูลรอบข้างหาย. ผลยังอยู่ validating ไม่เริ่ม job.
ตรวจ signature/ข้อมูลขนาด/ส่วนปิดไฟล์แล้ว; การถอดรหัสและเตรียมภาพเต็มเป็นงานช่วงถัดไป.

ฐาน task ช่วง1 ยังเป็น internal adapter เท่านั้น: migration022 เพิ่ม task,
การจองพื้นที่, metadata ไฟล์, events และ usage เมื่อจบงาน. ตัวรับเขียนเป็นช่วง
และหมดอายุสามชั่วโมงนับจากเวลาสร้าง; ตรวจ cleanup ทุกสิบวินาทีและกู้เมื่อเริ่ม
adapter ใหม่ โดยไม่ลบไฟล์ของ process ที่ยังทำงาน. ต้องเรียก stop ก่อนปิด pool.
ยังไม่มี public `POST /documents`, ไม่เริ่ม job และไม่ได้รับรอง Core input/PDF.
การเปิด API และการจอง scratch/PDF ของงานเดิมให้ครบยังเป็นงานช่วงถัดไป.

Owner: flowdoc-service. คู่มือนี้อธิบาย CLI, HTTP API และการทำงาน local ของโค้ด
candidate 0.4.7 ไม่ใช่การรับรอง production capacity; สถานะ release อยู่ใน Project Control
ขอบเขตและสถานะร่วมอยู่ใน flowdoc-project-control ที่
`docs/domains/flowdoc-page-system-roadmap-2026-10-10.md`
รูปแบบแม่แบบเป็นอำนาจของ Core ดู [คู่มือสร้างแม่แบบ](../../flowdoc-core/docs/template-guide.md)

คู่มือนี้ตาม candidate Service/Core 0.4.7 ซึ่งยังไม่ออก tag/ติดตั้ง; ตัวตนรุ่นที่ออกใช้อ้าง snapshot และ
annotated tag หลังผ่านเกณฑ์ออกรุ่น ไม่อนุมานจากชื่อ image. รองรับ Area18 ทั้ง schemaVersion 1
(Sarabun เดิม) และ 2 (คลังฟอนต์). เลข schema, รุ่นฟอนต์, รุ่นแม่แบบ และรุ่น Service
เป็นคนละค่า. คำสั่ง publish ด้านล่างคือเผยแพร่เวอร์ชันแม่แบบ ไม่ใช่ Git release;
ผู้ดูแลต้องมีคำอนุญาตเผยแพร่แม่แบบนั้นก่อนใช้.

## หน้าทดลอง API ในเครื่อง

ตัวอย่างนี้อยู่ใน `examples/api-client` และรวมอยู่ในรุ่น 0.3.0 สำหรับทดลองในเครื่อง
ใช้ Node 24 บนเครื่อง พร้อม API ที่เปิดและ publish แม่แบบแล้วตามขั้นตอนด้านล่าง
ไม่มี Editor และไม่สร้างแม่แบบหรือแก้ DB ให้ผู้เรียก

```powershell
$env:API_BASE='http://127.0.0.1:4318' # พอร์ต API ของชุดทดลองที่เปิดไว้
$env:CLIENT_PORT='4053'
node examples/api-client/serve.mjs
```

เปิด `http://127.0.0.1:4053` แล้วตรวจการเชื่อมต่อ:

1. โหลดหรือวาง JSON คำขอ API ที่มี `docKey` และตัวแปร หากไม่ระบุ `version`
   หน้าเว็บจะอ่าน Contract แล้วตรึงเวอร์ชันนั้นให้ชุดที่เตรียม
2. ถ้ามีรูป เลือก PNG/JPEG และใส่ชื่ออ้างอิงให้ตรงกับค่าตัวแปรภาพใน JSON
   ค่าเริ่มต้นคือชื่อไฟล์ไม่มีนามสกุล เช่น `logo.png` ใช้ `"logo"` ในตัวแปรภาพ
   ระบบแทนค่าเฉพาะช่อง `image` ตาม Contract รวม scope/array/Area ไม่แทนข้อความปกติ
   รูปทั้งหมดในชุดต้องเลือกใหม่ถ้าเปลี่ยนชุด upload; ไม่ผสม resource จาก upload เก่า
3. เลือก 1, 2 หรือ 6 คำขอ แล้วกดเตรียมข้อมูล อัปโหลดทีละไฟล์และแยก uploadId
   ต่อคำขอ เพื่อลดการชนเพดาน upload streams และไม่ให้ replay กลายเป็นงานเดียว
4. กดส่งชุดที่เตรียมแล้วเพื่อเรียก POST ใกล้กัน แต่ตัวประมวลผลยังทำทีละงาน
   การแก้ JSON หลังเตรียมไม่เปลี่ยนชุดที่เตรียมไว้ ต้องกดเตรียมใหม่
5. ดูสถานะจริงและรายละเอียด API; สำเร็จแล้วกดดาวน์โหลดเอง ไฟล์อาจหายหลังรับสำเร็จ
   หรือเมื่อหมดอายุ ตามการตั้งค่า Service ไม่มีการดาวน์โหลดล่วงหน้าหรือ retry POST

หน้าเว็บไม่เก็บ JSON/รูปใน localStorage การรีเฟรชทำให้รายการบนหน้าหาย แต่ job
บนระบบยังทำต่อ จด jobId เพื่อติดตามใหม่ได้ การติดตามหยุดหลัง 10 นาทีหรือเน็ตขาด
กดติดตามอีกครั้งด้วยรหัสเดิมได้ หากการส่ง POST ขาดตอนอาจรับงานไปแล้ว อย่าส่งซ้ำ
โดยไม่ตรวจสอบ คิวเต็ม/ข้อมูลผิด/รูปหมดอายุแสดง code และ path จาก API
รูปที่เตรียมแล้วแต่ไม่ส่งจะถูกเก็บกวาดตามอายุ upload ของ Service

ตัวช่วยเปิดหน้าเว็บรับเฉพาะ loopback และ API เป้าหมายที่กำหนดตอนเริ่ม ไม่ใช่ public
proxy; ไม่เพิ่ม CORS หรือ static route ให้ production Service ปิดด้วย Ctrl+C
การทดสอบข้อผิดพลาดของตัวอย่าง: `npx vitest run tests/api-client.test.mjs`

## 1. เริ่มต้นและออก PDF แรก

ตัวอย่าง area-document และ sections.main ในข้อ 1–5 ใช้ model18 เพื่อให้เอกสารเดิมยังใช้ได้.
สำหรับ model19 ใช้ sections เป็น array ระบุ ID ตาม contract; ห้ามแปลงชื่อเป็น ID เอง.

ใช้ Docker Desktop แบบ Linux containers บนเครื่อง x64 และ PowerShell 7
เปิด terminal ในโฟลเดอร์ flowdoc-service ที่มีโค้ด candidate 0.4.7
ไม่ต้องติดตั้งฐานข้อมูล Python หรือ Core แยกบนเครื่อง เพราะ image รวมไว้แล้ว
การ build ครั้งแรกต้องเชื่อมต่ออินเทอร์เน็ต

สร้างไฟล์ตั้งค่าทดลองครั้งเดียว เก็บไฟล์นี้ไว้ ไม่ส่งรหัสผ่านไปกับรายงาน:

```powershell
if (Test-Path .env.manual) { throw '.env.manual มีอยู่แล้ว ให้ใช้ไฟล์เดิม' }
$manualPassword = [guid]::NewGuid().ToString('N')
@(
  "FLOWDOC_DB_PASSWORD=$manualPassword"
  'FLOWDOC_REGISTRY_IMAGE=flowdoc-service:manual-0.4.7'
  'FLOWDOC_API_PORT=4318'
  'EXPORT_RETAIN_FILES=false'
) | Set-Content -Encoding utf8 .env.manual
$dc = @('compose', '--env-file', '.env.manual', '-p', 'flowdoc-manual')
docker @dc build registry
docker @dc up -d --wait db
docker @dc run --rm registry migrate
docker @dc run --rm registry draft-import examples/area-document-template.json
docker @dc run --rm registry publish tpl-area-document manual-first
docker @dc run --rm registry show area-document 1
docker @dc up -d api
```

ตรวจแต่ละคำสั่งว่าจบสำเร็จก่อนทำขั้นถัดไป ฐานข้อมูลและไฟล์อยู่ใน volumes
ของ project `flowdoc-manual` หาก port 4318 ใช้อยู่ ให้เปลี่ยนค่าก่อนเริ่ม API
เปิด terminal ใหม่ให้กำหนด `$dc` อีกครั้ง ไม่ต้องสร้างรหัสผ่านหรือ import ซ้ำ
`CURRENT_EXISTS` หมายถึงมีฉบับแก้ไขอยู่แล้ว ไม่ใช่คำสั่งแทนที่ข้อมูลเดิม
`migrate` ของชุดนี้ต้องผ่าน migrations 016–023 เพิ่มจากฐาน 015; ฐานใหม่ใช้ทั้งหมด
และการรันซ้ำที่ครบแล้วไม่ควรมีรายการ applied ใหม่. ห้ามแก้ SQL migration ที่ใช้แล้ว.
ตัวอย่างแรกใช้ Sarabun เดิม จึงยังไม่ต้องนำเข้าคลังหรือเปิดสิทธิ์ admin.

รอ `/health` ตอบสำเร็จ แล้วส่งข้อมูลตัวอย่าง:

```powershell
$base = 'http://127.0.0.1:4318'
Invoke-RestMethod "$base/health"
$contract = Invoke-RestMethod "$base/templates/area-document/contract?version=1"
$contract.value | ConvertTo-Json -Depth 100
$request = Get-Content examples/area-document-request.json -Raw
$receipt = Invoke-RestMethod "$base/jobs" -Method Post `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($request))
$jobId = $receipt.value.jobId
$deadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep -Milliseconds 500
  $job = Invoke-RestMethod "$base/jobs/$jobId"
  if ((Get-Date) -gt $deadline) { throw "ยังไม่เสร็จ ให้ตรวจ job $jobId ต่อ" }
} while ($job.value.status -in @('queued', 'running'))
$job | ConvertTo-Json -Depth 100
if ($job.value.status -ne 'succeeded') { throw 'ออกเอกสารไม่สำเร็จ ดู diagnostics ของ job' }
New-Item -ItemType Directory -Force artifacts/manual | Out-Null
Invoke-WebRequest "$base/jobs/$jobId/pdf" -OutFile artifacts/manual/first.pdf
```

อ่าน warnings แม้สถานะ succeeded และเปิด PDF ที่บันทึกไว้ตรวจเนื้อหา
ค่าเริ่มต้นลบ PDF ฝั่งเซิร์ฟเวอร์หลังส่งสำเร็จ การดาวน์โหลดซ้ำจึงอาจได้ 410
ไฟล์ที่บันทึกลงเครื่องยังอยู่ ใช้ `docker @dc stop` เมื่อลองเสร็จ และ
`docker @dc up -d api` เพื่อกลับมาใช้ข้อมูลเดิม อย่าลบ volumes ถ้าต้องการเก็บแม่แบบ

## 2. ผู้สร้างแม่แบบกับผู้เรียก API ทำคนละส่วน

ผู้สร้างกำหนดโครงหน้า node รูปแบบย่อย ตัวแปร และตัวอย่าง แล้ว publish เวอร์ชัน
ผู้เรียก API ส่งเฉพาะข้อมูลตาม contract ไม่ต้องส่งกราฟ node หรือจัดตำแหน่งเอง

```json
{
  "docKey": "area-document",
  "version": 1,
  "data": {},
  "sections": {
    "main": {"data": {"details": [
      {"format": "meeting", "data": {"companies": [
        {"name": "บริษัทตัวอย่าง", "members": [{"name": "ผู้เข้าร่วม"}]}
      ]}}
    ]}}
  }
}
```

`data` เป็นค่ากลาง ส่วน `sections.main.data.details` เป็นค่าของ Area ที่ประกาศไว้
ระบุ version เพื่อให้ได้แม่แบบเดิมเสมอ หากไม่ส่ง ระบบเลือกเวอร์ชันล่าสุดครั้งเดียว
ตอนรับงานและล็อกไว้กับ job การ publish ใหม่ไม่เปลี่ยน job ที่รับไปแล้ว

## 3. แก้ฉบับปัจจุบันและสร้างเวอร์ชัน

CLI ตอบ JSON envelope ที่มี `ok`, `value` หรือ `issues` ตรวจผลก่อนใช้ `value`

```powershell
$draft = (docker @dc run --rm registry draft-show tpl-area-document) | ConvertFrom-Json
if (!$draft.ok) { throw ($draft | ConvertTo-Json -Depth 100) }
New-Item -ItemType Directory -Force artifacts/manual-input | Out-Null
$draft.value | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8 artifacts/manual-input/current.json
```

แก้ไฟล์ `current.json` โดยรักษา ID และ revision เดิม จากนั้น:

```powershell
$inputFolder = (Resolve-Path artifacts/manual-input).Path
docker @dc run --rm -v "${inputFolder}:/input:ro" registry draft-save /input/current.json
docker @dc run --rm registry publish tpl-area-document manual-second
```

โหลด draft ใหม่ทุกครั้งหลัง save เพื่อรับ revision ล่าสุด การ save ด้วย revision เก่า
ถูกปฏิเสธ เปลี่ยน key ของตัวแปรให้คง ID และแก้ binding ที่อ้าง key นั้นด้วย
publish ตรวจความถูกต้องก่อนสร้าง snapshot แยก พร้อม ID ใหม่และเลขเวอร์ชันถัดไป
request ID เดิมของ template เดิมคืนเวอร์ชันเดิม เป็นการ retry ไม่ใช่สร้างเวอร์ชันใหม่
ใช้ request ID ใหม่เมื่อตั้งใจออกเวอร์ชันใหม่ การแก้/ลบ current ไม่เปลี่ยน snapshot

แม่แบบใหม่ใช้ไฟล์แบบ [examples/area-document-template.json](../examples/area-document-template.json)
mount โฟลเดอร์แบบข้างบนแล้ว `draft-import /input/template.json`
ส่วน `register` เป็นทางรับแม่แบบพร้อมเลขเวอร์ชันที่กำหนดเอง ไม่ใช่ workflow แก้ draft
อย่าแก้ DB โดยตรงเพื่อข้าม validation หรือเพิ่มเลขเวอร์ชันเอง

## 4. ภาพ: รับให้ครบก่อนสร้าง job

ตัวแปร `image` รับ resource UUID ไม่รับ URL หรือ Base64 โดยตรงใน `/jobs`
รับ JPEG/PNG ผ่าน upload แล้ว finalize ก่อน; ready หมายถึงรับข้อมูลครบ
การดาวน์โหลด URL, ตรวจภาพและลดขนาดเกิดในขั้นเตรียมทรัพยากรของ job

1. `POST /uploads` ส่ง manifest พร้อม requestKey และรายการภาพ
2. อ่าน uploadId และ resourceId ที่ระบบคืน
3. ส่ง binary ไป `PUT /uploads/{uploadId}/items/{resourceId}/content`
4. `POST /uploads/{uploadId}/finalize`
5. ส่ง `/jobs` พร้อม uploadId และใส่ resourceId ลงตัวแปร image

ตัวอย่าง manifest ไฟล์ (byteSize ต้องตรงกับจำนวนไบต์จริง):

```json
{"requestKey":"my-upload-001","items":[
  {"key":"photo","source":"upload","mediaType":"image/jpeg","byteSize":12345}
]}
```

หากติดตั้ง Node 24 ไว้ ใช้ตัวช่วยที่ทำขั้นตอน 1–4 ให้แล้ว:

```powershell
node examples/upload-client.mjs C:/images/photo.jpg image/jpeg http://127.0.0.1:4318
```

หรือประกาศ URL ด้วย `{"key":"photo","source":"url","url":"https://example.com/photo.jpg"}`
URL ต้องเข้าถึงได้โดยไม่ส่ง credentials; รูปที่ต้อง login ให้ผู้เรียกโหลดแล้ว upload
Base64 ขนาดเล็กส่ง `{ "data": "..." }` ไป endpoint `/base64` แทน `/content`
ใช้ข้อมูล Base64 ล้วน ไม่เติม `data:image/...;base64,`

ไฟล์รับได้เริ่มต้น 50 MiB ต่อรูป, 200 MiB ต่อชุด, 20 รายการ; Base64 1 MiB หลังถอดรหัส
ขนาดไฟล์ที่รับได้ไม่รับประกันว่าภาพจะผ่านงบ decode ทุกภาพ ภาพเสีย/URL โหลดไม่ได้
อาจได้ PDF พร้อมกรอบว่างและ warning ระบบเตรียมภาพที่ 200 DPI แบบรักษาสัดส่วน
ไม่ขยายพิกเซลต้นฉบับให้ใหญ่ขึ้นเพื่ออ้างว่าคมกว่าเดิม

## 5. ลอง Area พร้อมภาพ

```powershell
docker @dc run --rm registry draft-import examples/area-template.json
docker @dc run --rm registry publish area-demo area-first
Invoke-RestMethod "$base/templates/area-demo/contract?version=1"
```

นำ ID ที่ได้จาก upload มาแทนข้อความตัวอย่าง แล้วส่งเหมือนขั้นตอน `/jobs` ข้างต้น:

```json
{
  "docKey": "area-demo", "version": 1, "uploadId": "UUID ของชุด upload",
  "data": {},
  "content": [{"format":"evidence","data":{"details":[
    {"format":"notice","data":{}},
    {"format":"evidence","data":{"photo":"resource UUID","caption":"ผลทดสอบ"}}
  ]}}]
}
```

`details` คือ key ของตัวแปร area ที่ผู้สร้างตั้ง; `format` ข้างในเลือกชื่อโครงย่อย
ที่ area นั้นรองรับ ไม่ใช่ ID ของ node อ่าน `areaFormats` ใน contract ร่วมกับ
`areaId` ของตัวแปร เพราะคนละ area อาจมีโครงย่อยชื่อเหมือนกันได้
`[]` หมายถึงไม่มีรายการ และไม่เหมือนแม่แบบที่ประกาศ area โดยไม่มีโครงย่อยรองรับ
รายการย่อยผิดหรือชื่อไม่รู้จักถูกข้ามพร้อม warning จึงต้องตรวจผลทุกครั้ง

## 6. สถานะ ข้อผิดพลาด และอายุข้อมูล

| สิ่งที่ตรวจ | ความหมาย |
| --- | --- |
| queued / running | รับงานแล้ว / กำลังทำ |
| processing.stage | preparing-resources, rendering, complete หรือ failed |
| processing.completed / total | จำนวนช่องภาพที่เตรียม ไม่ใช่เปอร์เซ็นต์ทั้งเอกสารหรือ ETA |
| succeeded | มีผลลัพธ์ แต่ต้องอ่าน warnings |
| failed | อ่าน diagnostics ก่อนแก้ข้อมูล/ลองใหม่ |
| outputAvailable / downloadUrl | ยังมีไฟล์ให้รับหรือไม่ |
| 400 | เช่น JSON เสีย หรือ key ซ้ำ แม้สะกดด้วย escape ต่างกัน |
| 413 | request เกินขนาดที่กำหนด |
| 422 | เช่น required ขาด, type ผิด หรือ resource ไม่ตรงชุด |
| 404 | ไม่พบสิ่งที่เรียก เช่น template/version/job |
| PDF 409 / 410 | ยังไม่พร้อม / ไฟล์ถูกใช้หรือลบแล้ว |

คำขอที่ไม่ผ่าน validation ไม่สร้าง job; ไม่แปลงชนิดข้อมูลให้เงียบ ๆ
งานที่ใช้ upload เดิม retry ด้วยข้อมูล/เวอร์ชันเดิมคืน job เดิม แต่เปลี่ยนข้อมูลจะ conflict
การ retry ไฟล์ upload ที่สำเร็จแล้วต้องเป็นไบต์เดิม; การรับไฟล์ขาดให้ส่งทั้งไฟล์ใหม่
ไม่มีระบบ resume ตาม byte offset

ชุด upload ที่ยังไม่ claim หมดอายุเริ่มต้น 1 ชั่วโมงตามนโยบาย idle/ready
เมื่อผูกกับ job แล้วจะรักษาข้อมูลระหว่างรอ/ทำงานและอีก 1 ชั่วโมงหลังจบ
PDF ใช้นโยบายแยก: `EXPORT_RETAIN_FILES=false` ลบหลังส่งสำเร็จ
ถ้า true เก็บดาวน์โหลดซ้ำตาม `EXPORT_FILE_TTL_HOURS` (เริ่มต้น 24 ชั่วโมง)
ไฟล์ที่ยังไม่มีใครรับมี `EXPORT_TEMP_FILE_TTL_HOURS` เริ่มต้น 24 ชั่วโมง
เปลี่ยน env แล้ว recreate API; นโยบายใหม่ใช้กับผลลัพธ์ใหม่

API export ตัวอย่างนี้เป็น localhost และมี coordinator เดียว ประมวลผลเอกสารเรียงกัน.
authoring/admin ใช้ token และ principal แยกตามส่วนคลังฟอนต์ด้านล่าง;
ไม่ได้เพิ่มระบบบัญชีผู้ใช้หรือหน้า admin.
หลัง restart งาน queued ทำต่อ แต่งาน running ที่ถูกตัดจบเป็น PROCESS_INTERRUPTED
รายละเอียด configuration และการทดสอบอยู่ใน [README](../README.md)
ยังไม่รวม DOCX, หน้าแก้ไขเอกสาร หรือ SLA งานพร้อมกันจำนวนมาก; ระบบหน้าและหัวท้ายใช้สัญญา Area18


## รูปแบบแม่แบบ Area 18

ตั้งแต่รุ่น 0.3.0 และในชุด 0.4.0 รับเฉพาะ `nodeModelVersion: 18` ไม่แปลง model4–17 อัตโนมัติ
SQL migrations เดิมยังเก็บตาม checksum แต่ข้อมูลแม่แบบรุ่นเก่าไม่สามารถนำมาสร้างงานได้
สำรองฐานข้อมูลก่อนอัปเกรดและตรวจแม่แบบที่ต้องใช้ก่อนเปลี่ยนบริการ

ดู `examples/area-document-template.json` และ `examples/area-document-request.json`
Section มี authored fragment หรือหน้าปก, inputSchema และ `formats: {}`
เนื้อหาที่ผู้เรียกเลือกเรียงต้องประกาศตัวแปร `area` และรูปแบบใน `areaFormats`
ส่งข้อมูลผ่าน `sections.<key>.data` โดยค่าของ Area เป็นรายการ `{format,data}`
ไม่ส่ง `content` ที่ระดับบนหรือใน Section ตัวอย่าง static/cover ไม่จำเป็นต้องมี Area

แม่แบบรองรับหัวท้ายแยก schema, เลขหน้า, สารบัญ, ภาพ, ลิงก์ และ array สองระดับ
ผู้สร้างกำหนด rowGroups และกติกาจัดหน้า ผู้เรียกส่งเพียงข้อมูลตาม contract

## 0.3.0: คิวเต็มและงานล้มเหลว

รุ่น 0.3.0 รวมการจำกัดคิวและการจัดการงานที่ถูกขัดจังหวะดังนี้
ระบบยังสร้างเอกสารทีละงาน โดย `JOB_MAX_OUTSTANDING=10` จำกัดจำนวนงานที่
`queued` รวมกับ `running` ไม่เกิน 10 งาน เปลี่ยนค่าได้ผ่าน environment
ของ server หรือ Compose แล้วสร้าง API container ใหม่ ค่าเป็นจำนวนเต็มบวก
นี่เป็นเพดานรับงาน ไม่ใช่คำรับรองว่าจะสร้าง 10 เล่มเสร็จภายในเวลาที่กำหนด

| สิ่งที่พบ | ความหมายและการจัดการของผู้เรียก |
| --- | --- |
| POST /jobs ได้ 202 พร้อม jobId | รับงานแล้ว เก็บ jobId และติดตาม GET /jobs/:jobId |
| POST /jobs ได้ 503 QUEUE_FULL | คิวเต็ม ไม่สร้างงานหรือผูกชุดรูปใหม่ รอแล้วลองอีกครั้งได้หากชุดรูปยังไม่หมดอายุ |
| POST /jobs ได้ 503 UNAVAILABLE | ตัวประมวลผลไม่พร้อม ให้รอบริการกลับมาก่อน |
| อัปโหลดได้ 429 UPLOAD_BUSY | ช่องอัปโหลดเต็ม แยกจากจำนวนงานในคิว |
| GET /jobs/:jobId ได้ status failed | งานจบแบบล้มเหลว อ่าน errors; ไม่ควร polling รอ PDF ต่อ |
| errors มี PROCESS_INTERRUPTED | งานกำลังทำถูกขัดจังหวะ เมื่อเริ่ม processor ใหม่จะระบุว่าล้มเหลว ไม่ทำซ้ำอัตโนมัติ |
| errors มี RENDER_FAILED | การสร้างเอกสารล้มเหลวหรือเกินขีดจำกัด รหัสนี้ไม่ได้ระบุว่าเป็น timeout ทุกครั้ง |

งานที่สำเร็จหรือล้มเหลวไม่กินช่องคิวอีก ส่วนงาน queued ที่ยังไม่ได้เริ่มจะรอ
processor กลับมาทำต่อ ชุดอัปโหลดที่ผูกกับงาน queued/running ได้รับการเก็บตาม
กติกาของงาน ต่างจากชุดรูปที่ยังไม่ได้ผูกงานและยังหมดอายุตามปกติ

คำขอเดิมที่ใช้ uploadId และข้อมูลเหมือนเดิมคืนงานเดิม แม้คิวเต็มหรือ
งานเดิมล้มเหลวแล้ว จึงไม่ใช่คำสั่งทำงานใหม่ หากต้องสร้างงานใหม่ที่มีรูป
ให้สร้างชุดอัปโหลดใหม่แล้วส่งคำขอใหม่ ไม่เปลี่ยนข้อมูลแอบใช้ uploadId เดิม

ถ้าส่ง POST แล้วการเชื่อมต่อขาดก่อนรู้ผล อย่าถือว่ายังไม่มีงานและส่งซ้ำทันที:
คำขอแรกอาจถูกยอมรับแล้ว งานไม่มีรูปยังไม่มีการป้องกันคำขอซ้ำแบบทั่วไป
ระบบไม่ได้ลอง POST ซ้ำให้อัตโนมัติ และยังไม่รับรองลำดับการกดพร้อมกัน
เป็นลำดับเสร็จงานหรือมีเวลาเสร็จโดยประมาณ

เมื่อ status เป็น succeeded ให้ตรวจ outputAvailable ก่อนดาวน์โหลดตาม downloadUrl
ไฟล์ชั่วคราวถูกลบหลังส่งสำเร็จตามค่าเริ่มต้น การดาวน์โหลดซ้ำคืน 410
อย่าแปลว่างานสร้างล้มเหลวเพียงเพราะไฟล์ถูกใช้ไปหรือหมดอายุแล้ว

## 7. เปิดคลังฟอนต์และเครื่องมือผู้ดูแลใน 0.4.0

รุ่นแรกใช้เครื่องมือผู้ดูแล ยังไม่มีหน้า admin. รับเฉพาะ static TTF พร้อม license
และหลักฐาน Google Fonts; ไฟล์อยู่ในคลังของ Service เสมอ ไม่โหลด Google Fonts
ระหว่างสร้าง PDF. การเพิ่ม face ภายหลังเป็นรุ่นฟอนต์ใหม่ ไม่แก้ชุดที่เคยออกใช้แล้ว.
README อธิบาย API; ส่วนนี้เป็นลำดับปฏิบัติสำหรับผู้ดูแล.

Base `compose.yaml` ยังไม่ส่ง token ให้ API. สำหรับชุดทดลองใหม่ในข้อ 1 ให้เก็บ
token คนละค่าที่มีอย่างน้อย 32 ตัวอักษรและ principal ไว้ใน `.env.manual`:

```powershell
if (Select-String -Path .env.manual -Pattern '^(AUTHORING_TOKEN|FONT_ADMIN_TOKEN)=' -Quiet) {
  throw 'มี token แล้ว ให้ใช้ค่าเดิม ไม่สร้างทับ'
}
$manualAuthoringToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$manualFontAdminToken = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
@(
  "AUTHORING_TOKEN=$manualAuthoringToken"
  'AUTHORING_PRINCIPAL=manual-author'
  "FONT_ADMIN_TOKEN=$manualFontAdminToken"
  'FONT_ADMIN_PRINCIPAL=manual-font-admin'
) | Add-Content -Encoding utf8 .env.manual
```

เก็บไฟล์เฉพาะผู้ดูแล ไม่ commit หรือแนบรายงาน. บันทึก YAML ต่อไปนี้เป็น
`artifacts/manual-input/fonts.compose.yaml` (สร้างโฟลเดอร์ก่อน); ไม่มีค่าลับใน YAML:

```yaml
services:
  api:
    environment:
      AUTHORING_TOKEN: ${AUTHORING_TOKEN:?Set AUTHORING_TOKEN}
      AUTHORING_PRINCIPAL: ${AUTHORING_PRINCIPAL:?Set AUTHORING_PRINCIPAL}
      FONT_ADMIN_TOKEN: ${FONT_ADMIN_TOKEN:?Set FONT_ADMIN_TOKEN}
      FONT_ADMIN_PRINCIPAL: ${FONT_ADMIN_PRINCIPAL:?Set FONT_ADMIN_PRINCIPAL}
      FONT_STORAGE_DIR: /app/staging/fonts
```

```powershell
$dc = @('compose', '--env-file', '.env.manual', '-p', 'flowdoc-manual',
  '-f', 'compose.yaml', '-f', 'artifacts/manual-input/fonts.compose.yaml')
docker @dc run --rm registry migrate
docker @dc up -d api
```

ใช้ `$dc` ชุดนี้สำหรับคำสั่งต่อไปใน project เดิม. `staging` volume ของ Compose
เก็บ `/app/staging/fonts` ด้วย จึงต้องสำรองทั้งไฟล์และ DB คู่กัน. ถ้าแยก API/worker
ต้องอ่านคลังชุดเดียวกัน. admin config ขาดบางส่วนหรือ token ซ้ำกับ authoring
ทำให้เริ่มบริการไม่ผ่าน; ไม่ตั้ง admin ทั้งคู่จะปิด admin routes.
authoring token ใช้ admin routes ไม่ได้ (403); อย่าส่ง admin credential ให้ AI.

เครื่องมือผู้ดูแลรันบน host หลัง `npm ci --ignore-scripts` และ `npm run build`:

```powershell
$env:FONT_ADMIN_BASE_URL = 'http://127.0.0.1:4318'
# กำหนด FONT_ADMIN_TOKEN ใน environment จากค่าลับเดิมด้วยวิธีของผู้ดูแล
node dist/fonts/cli.js show --request artifacts/manual-input/font-show.json
```

`font-show.json` ใช้รูปแบบ `{"entity":"release","id":"<release UUID ที่มีจริง>"}`;
แทนค่าตัวอย่างก่อนใช้. CLI คืน `ok/value/issues`; ถ้า `ok:false` หยุดและอ่าน code.
token ส่งใน header ไม่ใช่ argument. เรียก localhost หรือ HTTPS ตามข้อจำกัด client.

| ลำดับ | คำสั่งและข้อมูลที่ต้องเตรียม |
| --- | --- |
| 1 | `family-create`: requestId/reason, displayName, internalNames, sourceIdentity ของ Google Fonts; ใช้ family เดิมเมื่อพบแล้ว |
| 2 | `import`: files/licenseFiles เป็นรายการ clientKey/path บน host, sourceEvidence ผูก file hash/metadata hash/ต้นทาง/เวลารับ/น้ำหนักต้นทาง/license keys; client คำนวณ hash/ขนาดและส่งไฟล์ |
| 3 | `import-inspect`: id ของ import, requestId/reason/expectedRevision; ใช้ asset และ sourceEvidence IDs จากผลตรวจ ไม่เดาจากชื่อไฟล์ |
| 4 | `release-stage`: familyId/version/importId/languageScope/faceBindings พร้อม requestId/reason; แยก rawWeight, sourceWeight และ approvedWeight; บันทึก conflictResolution เมื่อขัดกัน |
| 5 | `review-submit`, `review-run`: ใช้ manifestDigest และ revision ปัจจุบัน; อ่าน review ID กับรายงานที่คืน และเปิด specimen PDF ทุกหน้าก่อนอนุมัติ |
| 6 | `review-approve`: review ID, manifestDigest, reportDigest, artifactHashes ครบทุก face และ revision ของ release; ต้องมี normal 400 และผ่าน license/hash/ภาษา/renderer checks |
| 7 | `activate`: ใช้ release ID และ revision ใหม่หลัง approve; การ render หรือสถานะ ready ยังไม่ทำให้เลือกใช้ได้ |

ทุก mutation ใช้ requestId/reason; action ที่แก้ release ใช้ expectedRevision
ของ release แม้ URL ชี้ review. `default-set` ใช้ revision ของ family.
retry หลังผลไม่ชัดใช้ requestId และเนื้อหาเดิม แล้ว `show` อ่านสถานะปัจจุบัน;
ไม่สร้าง request ใหม่เพื่อข้าม conflict. รูปแบบ field ดู
[input types](../src/fonts/types.ts), [CLI client](../src/fonts/client.ts) และ
[lifecycle contract](../src/fonts/lifecycle.ts). คำสั่งอื่นได้แก่ `release-edit`,
`review-withdraw`, `retire`, `reactivation-review`, `default-set`, `release-delete`.

| สถานะ | สิ่งที่ทำได้ |
| --- | --- |
| preparing / needs_changes | แก้ชุดเตรียมและส่งตรวจใหม่ ยังเลือกในเอกสารไม่ได้ |
| in_review | รันและตรวจหลักฐาน; ต้อง withdraw ก่อนแก้ชุด ไม่อนุมัติรายงานเก่า |
| ready | ตรวจผ่านและอนุมัติแล้ว รอ activate |
| active | เลือกใหม่ได้ ตั้งเป็น default ของ family ได้อย่างชัดเจน |
| retired | หยุดเลือกใหม่; เอกสารเดิมและสำเนาที่ server ยืนยันสิทธิ์สืบทอดใช้ต่อได้ |

การ retire default ต้องระบุ active replacement ใน family เดียวกัน หรือ
`clearDefault=true` พร้อม expectedFamilyRevision. การเปิด retired กลับใช้ review
ชุดเดิมที่ตรึงไว้ใหม่ก่อน activate; การลบมีได้เฉพาะ preparing ที่ไม่เคย active
และไม่มี review/reference history ตามกฎ Service ไม่ใช่ลบไฟล์/ประวัติ audit เอง.

## 8. เลือกฟอนต์ ตรวจ draft และสร้าง PDF

เลือก release/weight/style ที่มีจริงจาก `GET /authoring/fonts`; หน้าอ่าน authoring
ใช้ Bearer authoring token. ไม่เลือกตามชื่อ family ลอย ๆ หรือรุ่นล่าสุดอัตโนมัติ.
Schema 2 ใช้ `font:{kind:'library',releaseId,weight,style}` ตามคู่มือ Core.
default ที่เปลี่ยนภายหลังไม่เปลี่ยนเอกสาร และไม่มี fallback/ตัวหนาหรือตัวเอียงจำลอง.

| ผล readiness | การจัดการ |
| --- | --- |
| ready | ผ่านเฉพาะ checkedScope ที่รายงาน; ต้องตรวจ actual_input ก่อนส่งงานจริง |
| blocked | บันทึก draft ที่โครงสร้างถูกต้องค้างได้ แต่แก้ release/face/glyph/สิทธิ์ก่อนสร้าง PDF |
| incomplete | ยังตรวจไม่ครบ อ่าน issues และตรวจใหม่ ไม่ถือว่าพร้อมออก PDF |

save/get/validate คืน `fontReadiness` แยกจาก revision. ปัญหาโครงสร้างฟอนต์ผิด,
ownership, stale revision หรือ idempotency conflict ปฏิเสธการบันทึกตามเดิม.
`checkedScope:styles` ไม่ยืนยันอักษรทั้งหมดที่เกิดจากข้อมูลจริง; ส่ง expectedRevision
และ sampleRequest ไป `POST /authoring/drafts/:id/font-readiness` เพื่ออ่าน actual_input.
ตัวอย่าง code: FONT_NOT_SELECTED, FONT_FACE_UNAVAILABLE, FONT_GLYPH_MISSING,
FONT_RELEASE_NOT_ACTIVE และ FONT_REFERENCE_NOT_RETAINED. ดู path และข้อมูลอักษร
ที่รายงานก่อนแก้ ไม่เปลี่ยนไปใช้ฟอนต์อื่นเงียบ ๆ.

clone ผ่าน `POST /authoring/drafts/:id/clone` ด้วย sourceRevision/name/docKey/
idempotencyKey; สิทธิ์ retired มาจาก revision ที่ server เก็บ ไม่ใช่ client แนบเอง.
FlowDocMake ใช้ `get_font_catalog`, `get_draft_font_readiness`, `clone_template_draft`;
ไม่มีคำสั่ง admin ในช่องทางนี้. ใช้ชุด client ที่เข้าคู่กับ Service/Core ปัจจุบัน.
ชุดส่งมอบนี้ใช้ FlowDocMake 0.2.5 ซึ่งตรึง checksum ของ Core tarball ใน
`vendor/manifest.json`; client 0.2.0 ตรึงแพ็กเกจก่อนปรับคู่มือและใช้แทนกันไม่ได้.
job ตรึงฟอนต์/ไฟล์/license ที่รับไว้ แม้เปลี่ยน default หรือ retire ระหว่างรอ;
ไฟล์หายหรือ hash ไม่ตรงต้องแก้ storage ไม่ข้ามการตรวจ. Sarabun schema 1 ยังใช้
ไฟล์ชุดเดิม; ไม่แก้เอกสารเดิมให้กลายเป็น schema 2 เพื่อให้ผ่าน.

### 8.1 ตัวช่วยความสูงฟอนต์: วัดและเก็บผล (development candidate หลัง 0.4.0)

ส่วนนี้อธิบายโค้ดช่วง 1 ที่ยังไม่ออก tag/ติดตั้ง; ไม่ใช่คำสั่งของ release 0.4.0 เดิม.
ข้อตกลงร่วมอยู่ Project Control
`docs/domains/flowdoc-font-height-adjustment-design-plan-2026-10-16.md` ข้อ 7.
ชุดปัจจุบันตรึง Core `0.4.7` และใช้ constant วิธีวัดจากแพ็กเกจจริง.
Core export `calculateFontHeightAdjustment` เป็น pure API รับ pt และ metric ต้นทาง/ปลายทาง
แล้วคืน pt ที่ปัด half-up หกตำแหน่ง หรือ error; ไม่เขียน draft และไม่เปลี่ยน renderer.
เครื่องมือ propose/confirm ของช่วง 3 มีแล้วตามข้อ 8.2; ต้องยืนยันก่อนเปลี่ยน pt.

ใช้ `node dist/fonts/cli.js <command> --request <file.json>` กับ FONT_ADMIN_BASE_URL/
FONT_ADMIN_TOKEN เดิม. Author token เรียก API เหล่านี้ไม่ได้; actor มาจาก auth.

| command | JSON เพิ่มจาก requestId/reason | ผล |
| --- | --- | --- |
| height-measure | id=releaseId, expectedRevision=release revision, manifestDigest | วัด Regular 400 จริงและคืน profile; request ซ้ำได้ผลเดิม |
| height-approve / height-revoke | id=profileId, expectedRevision=release revision, profileDigest | เพิ่มประวัติยืนยัน/ถอนผลวัด ไม่เปลี่ยนสถานะ release |
| height-assign | id=releaseId, expectedRevision=assignment revision (ครั้งแรก 0), profileId, profileDigest | ตั้งผลวัดที่อนุมัติเป็น current pointer ด้วย CAS |
| height-show | id=profileId เท่านั้น | อ่าน profile/hash/ผลวัดและ reviewStatus |

ผลวัดใช้ method `thai-bo-baseline-top-v1`: baseline ถึงยอดเส้นโค้งจริงของ บ,
unhinted รวม composite. topDesign เก็บ decimal string; ไม่รวมสระ/วรรณยุกต์.
ผลวัดแยกจาก immutable asset metadata และ release manifest; การอ่าน metadata ปกติ
ยังคืน shape เดิมเพื่อให้ review/re-activation ของฟอนต์ที่เก็บไว้แล้วทำงานต่อได้.
ไม่มี บ/Regular คืน unavailable diagnostic ที่อนุมัติไม่ได้ ไม่ใช่ font readiness blocker ใหม่.
reviewStatus ที่อ่านได้เป็นประวัติ review ไม่ใช่การรับรองไฟล์/manifest ปัจจุบัน;
การ assign ตรวจ binding/hash และประวัติล่าสุดซ้ำ. active/retired เดิมแนบผลวัดได้.

custom family ใช้ sourceIdentity `{provider:'custom',providerFamilyKey:'thsarabunnew'}`.
custom sourceEvidence ต้องมี providerFamilyKey เดียวกัน พร้อม provenance
`{sourceName,sourceVersion,obtainedFrom,rightsNote}`; metadataHash เป็น SHA-256 ของ
canonical JSON (sort keys) ของ provenance, fileHashBinding เป็น SHA-256 ของ TTF จริง.
locator ใช้ HTTPS ที่มาจริงหรือ `urn:flowdoc:custom:thsarabunnew`; ไม่ใส่พาธหรือ credentials.
แนบ license text UTF-8 ที่ถูกต้องผ่าน licenseFiles/licenseClientKeys เหมือนเดิม;
TH Sarabun New ใช้ข้อความ license ของตัวเอง ไม่ใช้ OFL ของ Google แทน.
sourceWeight ไม่ทราบใช้ null แล้วบันทึก conflictResolution ของ approvedWeight ตามกฎเดิม.
dedup bytes ไม่ลบที่มา/ใบอนุญาตของแต่ละ import; ไม่เปิด custom upload ให้ผู้เขียนทั่วไป.

## 9. เตรียมอัปเกรด สำรอง และตรวจหลังติดตั้ง

ส่วนนี้เป็นคู่มือปฏิบัติ ไม่ใช่คำสั่งให้ deploy ทันที. ก่อนอัปเกรดระบบที่มีข้อมูล:

1. จด image ID/คู่ Service-Core, vendor checksum, source commit, env/Compose และ
   migrations ที่ใช้อยู่. สำรอง config/credentials แยกจากหลักฐานที่แชร์.
2. หยุดรับงานใหม่ รอ queued/running ที่ต้องรักษาให้จบ แล้ว `docker @dc stop api`.
   สำรอง DB และ staging/fonts/รูป/PDF ที่ยังต้องใช้ในจุดที่สอดคล้องกัน.
3. เก็บ dump เป็นไฟล์ใน container แล้ว `docker cp` ออกมา เพื่อไม่ให้ PowerShell
   แปลงไบต์ dump ผ่าน text pipe; ตัวอย่างสำหรับ project ทดลองที่หยุด API แล้ว:

```powershell
$backupDir = Join-Path (Get-Location) ('artifacts/backup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupDir | Out-Null
$dbContainer = (docker @dc ps -q db).Trim()
if (!$dbContainer) { throw 'ไม่พบ DB container' }
docker @dc exec -T db pg_dump -U flowdoc -d flowdoc -Fc -f /tmp/flowdoc-before-upgrade.dump
if ($LASTEXITCODE -ne 0) { throw 'สำรอง DB ไม่สำเร็จ' }
docker cp "${dbContainer}:/tmp/flowdoc-before-upgrade.dump" (Join-Path $backupDir 'database.dump')
docker @dc cp api:/app/staging (Join-Path $backupDir 'staging')
docker @dc cp api:/app/output (Join-Path $backupDir 'output')
Get-FileHash (Join-Path $backupDir 'database.dump') -Algorithm SHA256
```

4. ตรวจว่าแต่ละคำสั่งสำเร็จ ตรวจ hashes และทดลอง restore dump/ไฟล์ใน DB กับ volumes
   แยกก่อนใช้เป็นแผนกู้คืน. ไม่ทดลอง restore ทับข้อมูลจริง และไม่ใช้ `down -v`.
5. ใช้ image ชุดใหม่ที่ตรึงไว้ รัน CLI `migrate` ให้ถึง 023 แล้วเปิด API. ไม่ย้อน SQL
   migration หรือแก้ checksum ถ้าล้มเหลว; วิเคราะห์และกู้คืนเป็นชุด DB/files/config/
   image ที่เข้าคู่กันจากสำรองที่ตรวจแล้ว แยกการอนุมัติก่อนกระทบข้อมูลจริง.
6. ตรวจ `/health`, คู่รุ่นจริง, admin/authoring permissions, catalog/readiness และ
   เปิด draft เดิมโดยไม่เปลี่ยน revision/fingerprint. ทดลอง PDF ด้วย draft ใหม่
   ให้ครอบคลุมหลาย family/faces, default เปลี่ยน, retired เดิม/clone และ Sarabun.
   บันทึก PDF ตรวจทุกหน้า/ข้อความ/embedded fonts; รูป upload เก่าหมดอายุให้รับรูปใหม่
   ไม่แก้สิทธิ์ฟอนต์เพื่อข้าม UPLOAD_GONE. restart แล้วตรวจ draft/catalog คงอยู่.

ผลตรวจเก่าใช้ซ้ำเฉพาะตัวโค้ด/dependencies/config/environment ที่ยังตรงกับหลักฐาน.
คำสั่งตรวจแยกจากข้อมูลจริง: `npm run check:database`, `npm run check:fonts`,
`node scripts/checkFontLifecycle.mjs`, `node scripts/checkFontTools.mjs`;
ตั้ง FONT_FIXTURE_DIR และ FLOWDOCMAKE_PROJECT_ROOT ตาม README เมื่อเกี่ยวข้อง.
tests บน host ต้องระบุชุดปัจจุบันและ DB ทดสอบแยก ไม่กวาด artifacts ที่มี tests เก่า.
เก็บผล FAIL/skipped และข้อจำกัดตามจริง; คำสั่งในคู่มือนี้ไม่ได้รับรองว่าการ deploy
ครั้งใหม่ผ่านแล้ว. ก่อน tag/release ใช้ [ลำดับตรวจการออกรุ่น](../../flowdoc-project-control/docs/domains/flowdoc-export-working-release-rules-draft-2026-10-09.md).

ข้อจำกัดจากหลักฐานติดตั้งทดสอบที่บันทึกไว้ก่อนเตรียมคู่มือนี้: native MCP connection
ของแชตเดิมเคยค้าง configuration แม้ fresh launcher/file-client ผ่าน; ต้องตรวจ
connection ที่จะใช้จริงอีกครั้ง. การ preview เอกสารเดิมที่รูปชั่วคราวหมดอายุเคยได้
UPLOAD_GONE จึงยังไม่ใช่หลักฐาน same-revision PDF ครบทุกเอกสารเดิม.
ชุดตรวจ CLI เดิม `tests/checkCurrentCli.mjs` เคยคาดให้รับ draft ที่ลบตัวแปรซึ่ง
ยังถูกใช้อยู่ จึงได้ INVALID_DATA `invalid section document` ตั้งแต่ save.
ตัวตรวจปัจจุบันตรวจการปฏิเสธ save และยืนยันว่า draft เดิมไม่เปลี่ยน ก่อนแก้ข้อมูล
ให้ถูกต้องแล้วออกแม่แบบรุ่นถัดไป; ใช้ผลตรวจของชุดส่งมอบยืนยัน ไม่แก้ validation
ของผลิตภัณฑ์เพื่อให้ตัวทดสอบเก่าผ่าน.
ใช้ผลล่าสุดของ candidate ที่จะออกรุ่นตัดสินตามเกณฑ์รับงาน ไม่ขยายผลจากการตรวจเอกสาร.

### 8.2 ขอเสนอและยืนยันขนาด (development candidate 0.4.7)

POST `/authoring/drafts/:id/font-height-adjustments` รับ expectedRevision/styleId/
targetFont/idempotencyKey. ใช้ credential เจ้าของ; metric และ pt อ่านจาก draft กับ
profile ที่ผู้ดูแลตรวจแล้วเท่านั้น. คืน proposedFontSizePt และ layoutCheck=not_checked;
ยังไม่เปลี่ยน draft. ยกเลิกได้โดยไม่ confirm.
POST `/authoring/drafts/:id/font-height-adjustments/:proposalId/confirm` รับเพียง
expectedRevision/idempotencyKey หลังเจ้าของเลือกใช้; บันทึก font+pt ใน transaction เดียว
ผ่าน write/reference/audit เดียวกับ save และคง lineHeightPt. Shared style มีผลต่อทุก node
ที่อ้าง style นั้น. ต้องตรวจ readiness และ preview ต่อ; save ไม่รับรอง layout.

ข้อเสนออายุ 15 นาที. TTL/revision/fingerprint/profile/assignment/review เปลี่ยนให้ขอใหม่;
retry key/body เดิมคืนผลเดิม ไม่เพิ่ม revision หรือยืดอายุ. key เดิมต่าง body เป็น conflict.
active หรือ retired exact tuple ที่ draft retained เท่านั้น. ไม่มี profile หรือ schema1
Sarabun คืน unavailable และยังใช้ ordinary pt/save/preview/clone ตามเดิม ไม่ migrate เอง.
Catalog heightProfile เป็นข้อมูล review เบื้องต้น; propose/confirm ตรวจ binding/files/สิทธิ์ซ้ำ.
Migration 020 เพิ่มตารางข้อเสนอเท่านั้น; ไม่แก้ schema1 definitions หรือ migration เดิม.
ใช้ฐานทดสอบแยกก่อน upgrade; รุ่นนี้ยังไม่อนุญาต install/deploy จากผลตรวจ development.

### 8.3 เตรียมส่งมอบตัวช่วยความสูงและการกู้คืน

Candidate ใช้ Service/Core `0.4.7` กับ FlowDocMake
`0.2.5` และ Core SHA256 ใน vendor/manifest.json.
นี่เป็นชุด development ที่ตรวจร่วม ไม่ใช่ release/tag หรือคำอนุญาตติดตั้งจริง.
Core schema/renderer เดิมไม่เปลี่ยน; helper ต้องยืนยันก่อนบันทึกและตรวจ PDF ทุกครั้ง.
IBM Plex Sans Thai, Pridi, Noto Sans Thai Looped และ Noto Serif Thai ชุดที่ได้รับ
ไม่มี italic; ห้ามนับเป็นผลผ่านของ italic หรือสร้างตัวเอียงแทน.

ก่อน upgrade หลังได้รับอนุญาต: หยุดรับงาน/รอ job จบ สำรอง PostgreSQL แบบ custom dump
และ staging/font library รวม licenses, output/temp ที่ต้องรักษา พร้อม config/secret
แยกไว้ในที่ปลอดภัย. ใช้ image/source/Core hash ที่ตรึง สั่ง migrate ไปถึง 023;
ห้ามแก้ bytes ของ 001–021. ตรวจ replay ไม่ apply ซ้ำ, admin/author แยก credential,
เปิด draft เดิม, catalog/default/retired, helper และ preview/download ก่อนเปิดงาน.
Profile/assignment/review และ proposals/receipts ต้องอยู่ใน dump เดียวกัน.

กู้คืน: หยุด candidate, ใช้ image ที่ตรง backup, คืน DB และไฟล์เป็นชุดเดียวในฐาน/volume
แยกก่อน ตรวจ ready/version/hash, draft revision/fingerprint, profile/receipt และ preview.
ข้อเสนอที่หมดอายุไม่ถูกต่ออายุหรือ apply เอง; retry ที่สำเร็จแล้วต้องได้ receipt เดิม.
อย่าเริ่ม binary เก่ากับ schema ใหม่หรือคืน DB โดยไม่มีไฟล์ฟอนต์ที่ตรง hash.
ช่วง 4 ทดสอบ dump+files restore ในฐานแยกและตรวจ PDF เทียบไบต์แล้ว; การติดตั้งกับ
ข้อมูลจริงและการย้าย stable version/tag ยังต้องผ่านกฎ release และคำอนุญาตรอบนั้น.

ตรวจซ้ำแบบจำกัดขอบเขตใช้ `tests/checkFontHeightDelivery.mjs` กับ config ของฐาน
ทดสอบที่ระบุ container ชัดเจน และ `tests/checkFontHeightPdf.py <state.json>`.
ต้องเตรียม dependencies ตาม runtime/fontTools และ PDF tools; ไม่ใช่เครื่องมือนำเข้าฐานจริง.
ผลอัตโนมัติแยกจาก visual review ทุกหน้า; ดูหลักฐานรอบที่ Project Control ระบุ.

## Format sizing development candidate

Core 0.4.7 accepts model19 Format `sizing` (auto/fixed), with independent
fixed maximum heights per Area entry at Section flow roots. Each call reserves
min(declared height, current body remainder), including short/empty content.
Positive space shows fitting whole units; only zero space omits the frame.
Fixed never moves/retries omitted content. Definitions, clones and saved
job snapshots retain sizing. `GET /authoring/contract` advertises `formatSizing`
v2 (diagnosticsVersion1); Area contract entries include explicitly selected sizing only. Partial PDFs
remain succeeded with structured FORMAT_* warnings. Status and stored warnings
retain diagnostics even if a later visible link/TOC to omitted content makes
the job fail (`LAYOUT_FAILED`, reason `omitted-destination`). Input data remains
complete and omission warnings are distinct from skipped input indices.
No migration or Area/request sizing field is introduced. Existing backup,
restore and installation steps still apply; this candidate is not installed.

### Streamed document task API (unreleased Service0.4.8 / Core0.4.7)

Enable only with the trusted `TASK_CREDENTIALS_FILE` mapping described in README.
Send `Authorization: Bearer <configured-task-token>`, `Doc-Key: <authorized-key>`,
`Content-Type: multipart/form-data; boundary=<request-boundary>` and optionally
`Accept: multipart/mixed`. The first part is `payload` with application/json:
`{"data":{},"sections":[{"id":"<saved-section-id>","data":{...}}]}` for model19;
model18 retains its Section map. Root docKey/taskId are not generation selectors.

An image value is `{"image":{"upload":true}}`, optionally with assetKey. A matching
binary part name is the original JSON Pointer ending at that image object. A keyed
reference `{"assetKey":"seal"}` can reuse a definition only in the same Section,
including definitions in that Section's assets array. Never send local paths in data.
No declared-size header, opening request, polling loop or error-level mode is needed.

Read multipart JSON feedback incrementally, then save the final exact-length PDF
and verify its SHA256 and closing boundary. HTTP200 or artifact metadata alone is
not success. If an error closes without a PDF, retain taskId for optional lookup.
If disconnected, the worker stops safely; only received originals remain until the
original expiresAt. A later JSON POST to the same route contains only taskId and
optional findings pagination; it returns status, never a PDF or new child job.
