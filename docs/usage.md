# คู่มือใช้งาน FlowDoc Service 0.2.14

## Authority Boundary

Owner: flowdoc-service. คู่มือนี้อธิบาย CLI, HTTP API และการทำงาน local ของโค้ด
รุ่น 0.2.14 ไม่ใช่การรับรอง production capacity; สถานะ release อยู่ใน Project Control
ขอบเขตและสถานะร่วมอยู่ใน flowdoc-project-control ที่
`docs/domains/flowdoc-page-system-roadmap-2026-10-10.md`
รูปแบบแม่แบบเป็นอำนาจของ Core ดู [คู่มือสร้างแม่แบบ](../../flowdoc-core/docs/template-guide.md)

## หน้าทดลอง API ในเครื่อง

ตัวอย่างนี้อยู่ใน `examples/api-client` และรวมอยู่ในรุ่น 0.2.14 สำหรับทดลองในเครื่อง
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

ใช้ Docker Desktop แบบ Linux containers บนเครื่อง x64 และ PowerShell 7
เปิด terminal ในโฟลเดอร์ flowdoc-service ที่มีโค้ด 0.2.14
ไม่ต้องติดตั้งฐานข้อมูล Python หรือ Core แยกบนเครื่อง เพราะ image รวมไว้แล้ว
การ build ครั้งแรกต้องเชื่อมต่ออินเทอร์เน็ต

สร้างไฟล์ตั้งค่าทดลองครั้งเดียว เก็บไฟล์นี้ไว้ ไม่ส่งรหัสผ่านไปกับรายงาน:

```powershell
if (Test-Path .env.manual) { throw '.env.manual มีอยู่แล้ว ให้ใช้ไฟล์เดิม' }
$manualPassword = [guid]::NewGuid().ToString('N')
@(
  "FLOWDOC_DB_PASSWORD=$manualPassword"
  'FLOWDOC_REGISTRY_IMAGE=flowdoc-service:manual-0.2.14'
  'FLOWDOC_API_PORT=4318'
  'EXPORT_RETAIN_FILES=false'
) | Set-Content -Encoding utf8 .env.manual
$dc = @('compose', '--env-file', '.env.manual', '-p', 'flowdoc-manual')
docker @dc build registry
docker @dc up -d --wait db
docker @dc run --rm registry migrate
docker @dc run --rm registry draft-import examples/srs-template.json
docker @dc run --rm registry publish tpl-srs-table-trial manual-first
docker @dc run --rm registry show srs-table-trial 1
docker @dc up -d api
```

ตรวจแต่ละคำสั่งว่าจบสำเร็จก่อนทำขั้นถัดไป ฐานข้อมูลและไฟล์อยู่ใน volumes
ของ project `flowdoc-manual` หาก port 4318 ใช้อยู่ ให้เปลี่ยนค่าก่อนเริ่ม API
เปิด terminal ใหม่ให้กำหนด `$dc` อีกครั้ง ไม่ต้องสร้างรหัสผ่านหรือ import ซ้ำ
`CURRENT_EXISTS` หมายถึงมีฉบับแก้ไขอยู่แล้ว ไม่ใช่คำสั่งแทนที่ข้อมูลเดิม

รอ `/health` ตอบสำเร็จ แล้วส่งข้อมูลตัวอย่าง:

```powershell
$base = 'http://127.0.0.1:4318'
Invoke-RestMethod "$base/health"
$contract = Invoke-RestMethod "$base/templates/srs-table-trial/contract?version=1"
$contract.value | ConvertTo-Json -Depth 100
$request = Get-Content examples/srs-request.json -Raw
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
  "docKey": "srs-table-trial",
  "version": 1,
  "data": {"projectName": "โครงการตัวอย่าง"},
  "content": [
    {"format": "section-note", "data": {"text": "บทนำ"}},
    {"format": "requirement-list", "data": {"items": [
      {"code": "REQ-001", "detail": "รายละเอียดข้อกำหนด", "remark": "ผ่าน"}
    ]}}
  ]
}
```

`data` เป็นค่ากลาง ส่วน `content` เรียงรูปแบบตามลำดับที่ต้องการในเล่ม
ระบุ version เพื่อให้ได้แม่แบบเดิมเสมอ หากไม่ส่ง ระบบเลือกเวอร์ชันล่าสุดครั้งเดียว
ตอนรับงานและล็อกไว้กับ job การ publish ใหม่ไม่เปลี่ยน job ที่รับไปแล้ว

## 3. แก้ฉบับปัจจุบันและสร้างเวอร์ชัน

CLI ตอบ JSON envelope ที่มี `ok`, `value` หรือ `issues` ตรวจผลก่อนใช้ `value`

```powershell
$draft = (docker @dc run --rm registry draft-show tpl-srs-table-trial) | ConvertFrom-Json
if (!$draft.ok) { throw ($draft | ConvertTo-Json -Depth 100) }
New-Item -ItemType Directory -Force artifacts/manual-input | Out-Null
$draft.value | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8 artifacts/manual-input/current.json
```

แก้ไฟล์ `current.json` โดยรักษา ID และ revision เดิม จากนั้น:

```powershell
$inputFolder = (Resolve-Path artifacts/manual-input).Path
docker @dc run --rm -v "${inputFolder}:/input:ro" registry draft-save /input/current.json
docker @dc run --rm registry publish tpl-srs-table-trial manual-second
```

โหลด draft ใหม่ทุกครั้งหลัง save เพื่อรับ revision ล่าสุด การ save ด้วย revision เก่า
ถูกปฏิเสธ เปลี่ยน key ของตัวแปรให้คง ID และแก้ binding ที่อ้าง key นั้นด้วย
publish ตรวจความถูกต้องก่อนสร้าง snapshot แยก พร้อม ID ใหม่และเลขเวอร์ชันถัดไป
request ID เดิมของ template เดิมคืนเวอร์ชันเดิม เป็นการ retry ไม่ใช่สร้างเวอร์ชันใหม่
ใช้ request ID ใหม่เมื่อตั้งใจออกเวอร์ชันใหม่ การแก้/ลบ current ไม่เปลี่ยน snapshot

แม่แบบใหม่ใช้ไฟล์แบบ [examples/srs-template.json](../examples/srs-template.json)
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

รุ่นนี้เป็น localhost ไม่มีสิทธิ์รายคน และมี coordinator เดียว ประมวลผลเอกสารเรียงกัน
หลัง restart งาน queued ทำต่อ แต่งาน running ที่ถูกตัดจบเป็น PROCESS_INTERRUPTED
รายละเอียด configuration และการทดสอบอยู่ใน [README](../README.md)
ยังไม่รวม DOCX, หน้าแก้ไขเอกสาร หรือ SLA งานพร้อมกันจำนวนมาก; ระบบหน้าและหัวท้ายดู model16 ด้านล่าง


## แม่แบบหลายส่วน (รุ่นพัฒนา0.2.9 / Core model12)

ใช้ [page-sections-template.json](../examples/page-sections-template.json) กับ
[page-sections-request.json](../examples/page-sections-request.json) ผ่าน current
import → publish → POST /jobs ตามขั้นตอนเดิม ข้อมูลตัวอย่างมี resource UUID จำลอง
ต้องอัปโหลดรูปจริงแล้วแทน data.photo และ photo ในรายการด้วย resourceId ของชุดนั้น
พร้อมส่ง uploadId ก่อนเรียก /jobs

ส่ง content: [] ได้เมื่อมีเนื้อหา authored จากแม่แบบ ตัวแปรรูปในส่วน authored
ยังต้องส่งและอยู่ใน upload ที่ claim ได้; ไม่ส่ง sections/pageLayouts จากผู้เรียก
GET contract ยังคงแสดง schema/formats/areaFormats/examples ไม่เปิดกราฟจัดหน้า
รูปแบบหน้าและส่วนเก็บใน payload/snapshot เดิม ไม่เพิ่มตารางหรือ migration
แก้ label โดยคง id ได้ การลบ global Area เก็บกวาดจุดวางใน authored section
และข้อมูลลูกของ current; เวอร์ชันที่ publish แล้วไม่เปลี่ยนตาม

ตัวอย่างนี้เป็นส่วนทั่วไปแนวตั้ง/แนวนอน ยังไม่ใช่ปกพิเศษหรือหัวท้าย
สถานะและลำดับงานอยู่ใน Project Control
`docs/domains/flowdoc-page-system-roadmap-2026-10-10.md`

## ปกและหน้าเปล่า (model13)

ตัวอย่างแม่แบบ: examples/cover-pages-template.json และ cover-pages-request.json
import/publish เหมือนแม่แบบเดิม ผู้เรียกยังส่ง data/content และ uploadId ถ้ามีภาพ
ปกหน้าแรกหนึ่งหน้า กล่องชื่อที่จองไว้ไม่ขยับข้อความด้านล่างเมื่อชื่อยาวขึ้นภายในกรอบ
ข้อมูลปกไม่เข้าสารบัญอัตโนมัติ ปกไม่นับเลข; หน้าเปล่าที่ประกาศนับแต่ไม่แสดงเลข
ถ้าข้อมูลจริงเกินกรอบหรือเกินปก job จะ failed และไม่มี PDF ให้ดาวน์โหลด
errors มี LAYOUT_FAILED พร้อม nodeId/sectionId เมื่อ Core ระบุต้นทางได้
ความผิดพลาดระบบ/หมดเวลา/ถูกยกเลิกยังใช้ RENDER_FAILED ไม่เปิดเผยรายละเอียดภายใน
อ่าน props และขอบเขต fixed-height ในคู่มือ Core; ไม่เปิดตัวเลือกเลขหน้าเต็มรูปแบบ
หรือหัวท้ายกระดาษในพาร์ตนี้ สถานะร่วมอยู่ Project Control page-system roadmap


## หัวท้ายแยกชุดข้อมูล (model14)

ใช้ examples/page-bands-template.json กับ page-bands-request.json.
ผู้สร้างแม่แบบกำหนด header/footer และชุดตัวแปร ผู้เรียกส่ง header/footer
เป็น object ระดับเดียวกับ data. data ใช้กับปก/เนื้อหาตามเดิม.
GET /templates/:docKey/contract ส่ง header/footer schemas เมื่อแม่แบบมี
โดยไม่ส่ง graph. ชื่อ key ซ้ำข้ามชุดได้ แต่ไม่มีการ fallback ข้ามชุด.

ภาพใน header/footer ใช้ upload resourceId เดิม พร้อม uploadId ใน request;
ระบบ claim/prepare ทรัพยากรและย่อภาพตามกรอบในหัวท้ายเหมือนภาพในเนื้อหา.
หากหัวท้ายสูงเกินกรอบ/เพดาน งานล้มด้วย LAYOUT_FAILED พร้อม path และ section
และไม่ให้ดาวน์โหลด PDF บางส่วน. ค่าที่ต้องคำนวณให้ผู้เรียกส่งผลลัพธ์มาเอง.

Migration010 เพิ่ม scope ใน variable_schemas และ variable_schema_versions.
ชุดข้อมูลเก่าคง ID เดิมและถูกจัดเป็น global/format; ข้อมูลใหม่แยก header/footer.
การ publish clone ID ชุดใหม่เหมือนเดิม; เปลี่ยน current ไม่เปลี่ยน snapshot.
ใช้ขั้นตอน migration เดิมก่อนเริ่ม API ของรุ่นใหม่. อย่าแก้ migration ที่เผยแพร่แล้ว.


## ข้อมูลแยกตาม Section (model15)

ใช้ `examples/section-ownership-template.json` และ `section-ownership-request.json`.
ขั้นตอน import → publish → POST /jobs เหมือนเดิม แต่ผู้เรียกเลือกข้อมูลตาม key
ที่ผู้สร้างแม่แบบกำหนด; ไม่ส่งกราฟหรือการจัดหน้ามาทาง API.

```json
{
  "docKey": "section-ownership",
  "data": {"projectName": "โครงการตัวอย่าง"},
  "sections": {
    "intro": {"data": {"title": "บทนำ"}, "header": {"name": "ส่วนแรก"}},
    "details": {"data": {"title": "รายละเอียด"}},
    "closing": {"data": {"title": "สรุป"}}
  }
}
```

`data` ระดับบนคือข้อมูลร่วม; ภายใน section มี `data`, `header`, `footer`
และ `content` สำหรับส่วนที่ประกาศ source เป็น content. แม่แบบกำหนดลำดับส่วน
การเรียง key ในคำขอไม่เปลี่ยนลำดับหน้า. ชื่อซ้ำข้ามชุดได้และไม่ fallback.
ถ้าไม่ส่ง section ระบบใช้ค่าว่างแล้วตรวจ required/default ของส่วนนั้น.
ชื่อ section ผิดจะตอบ `UNKNOWN_SECTION` พร้อม path และชื่อที่รับได้ โดยไม่สร้าง job.

GET contract คืน `sections.<key>` พร้อม id/label และ schemas/formats ที่รับได้
ไม่เปิดกราฟจัดหน้า. รูปใช้ resourceId จาก upload ที่ finalize แล้วเหมือนเดิม
พร้อม `uploadId` ระดับบน แม้ภาพอยู่ในหัวท้ายของ section.

Migration011 เพิ่ม sections/section_versions และเจ้าของ section บน formats กับ
variable schemas. ตัวแปรแต่ละตัวอ้างผ่าน schema เช่นเดิม. ID แถวฐานข้อมูลแยกจาก
sourceDefinitionId ของ Core; publish clone ID ใหม่และเชื่อมกันภายในเวอร์ชัน.
การแก้ current ไม่เปลี่ยน published version. ไม่แปลงแม่แบบ model4–14 อัตโนมัติ;
การเปลี่ยนเป็น model15 ต้องส่ง draft-save ที่มี mapping ครบและ revision ที่ตรง.
รูปแบบตัวอย่างเดิม model12–14 ด้านบนยังใช้สัญญาเดิมของแต่ละ model.

## เลขหน้าจากระบบ (model16)

ผู้สร้างแม่แบบใส่ inline `system-page-field` ใน TextBlock ของ header/footer
เลือก `field: current` หรือ `total` และกำหนด `width` เป็น mm/pt.
ผู้เรียก `/jobs` ไม่ต้องส่ง current/total; ค่าใน data ไม่สามารถแทนเลขระบบได้.
แต่ละ section เลือก numbering.mode เป็น continue, restart หรือ exclude
และ visibility เป็น show/hide. Total คือจำนวนหน้าที่ร่วมการนับทั้งเล่ม.
Cover ไม่นับและไม่แสดง; blank นับแต่ไม่แสดงโดยพื้นฐาน.
Hide ซ่อนทั้ง TextBlock ที่มีเลขโดยคงพื้นที่เดิม. ไม่มี field ก็ไม่มีเลขอัตโนมัติ.
ช่องเลขแคบเกินไปทำให้ job ล้มเหลวโดยไม่มี PDF ให้ดาวน์โหลด.

ดู examples/page-numbering-template.json และ page-numbering-request.json.
Migration012 ขยาย owner guards ให้รับ model15/16 โดยไม่เปลี่ยนข้อมูลเดิม.

## สารบัญตาม Section (Core0.1.14)

หัวข้อที่ผู้สร้างเลือกเข้าสารบัญยังใช้ระดับ1–3และ anchorId ตามเดิม.
หน้าที่ซ่อนเลขยังแสดงเลขนับในสารบัญ. หน้าที่ไม่นับเลขแสดงชื่อที่กดได้
แต่เว้นช่องเลขว่าง; ปกไม่เข้าสารบัญ. ตัวเลขที่เริ่มใหม่ไม่เปลี่ยนปลายทางลิงก์.
API ไม่ต้องส่งข้อมูลเพิ่ม. ดู examples/contents-sections-template.json และ
contents-sections-request.json; ไม่ต้องมี migration ใหม่สำหรับพฤติกรรมนี้.

## ทดลองทั้งเล่มและอัปเกรดเป็น 0.2.9

แม่แบบตัวอย่างครบอยู่ที่ `examples/page-system-template.json`:
ปก → สารบัญ → ตารางเซลล์รวม/ภาพ/Area → หน้าเปล่า → ส่วนซ่อน/ไม่นับเลข → ปิดท้าย.
`page-system-short.json` และ `page-system-long.json` เป็น request ของ version1.
ภาพสีเล็กใน page-system-image.png ใช้ตรวจตำแหน่ง ไม่ใช่ตัวอย่างคุณภาพภาพพิมพ์.
UUID ใน request เป็น placeholder ต้องแทนด้วย resourceId จาก upload ของตน.
ชุดนี้จงใจไม่ส่งโลโก้หัวกระดาษ และใช้ภาพสีขนาด2×1px เพื่อเทียบกับผลรับเดิม
จึงคาด IMAGE_LOW_RESOLUTION สองรายการและ IMAGE_UNAVAILABLE ของโลโก้เจ็ดรายการ.
สคริปต์ตรวจ warnings ชุดนี้ตรง ๆ; ไม่ใช่ข้อกำหนดว่าภาพจริงต้องมี warnings.

บน Docker project ทดลองใหม่ที่ตั้งตามขั้นตอนแรกของคู่มือ:

```powershell
docker @dc run --rm registry migrate
docker @dc run --rm registry draft-import examples/page-system-template.json
docker @dc run --rm registry publish page-system-release page-system-v1
docker @dc up -d api
$env:FLOWDOC_TEST_API_URL = 'http://127.0.0.1:4318'
node scripts/checkPageSystem.mjs
```

คำสั่งตรวจนี้ใช้ Node24 บนเครื่องผู้เรียกและ HTTP API เท่านั้น จะ upload รูป,
finalize, ส่งคำขอที่ตรึง version1, รอ job, ดาวน์โหลด PDFสั้น/ยาว และตรวจว่าดาวน์โหลด
ซ้ำไม่ได้ตามค่าเริ่มต้น EXPORT_RETAIN_FILES=false. ไฟล์อยู่ artifacts/page-system.
อย่ารัน fixture นี้กับข้อมูลใช้งานจริงหรือ import ซ้ำบน project เดิมโดยไม่ตรวจ.
ผู้ใช้ API ปกติทำขั้นตอนเดียวกันได้ด้วย HTTP client ของตน ไม่จำเป็นต้องติดตั้ง Node.

ก่อนอัปเกรดฐานข้อมูลที่มีข้อมูลจริง ให้สำรอง DB และพื้นที่ไฟล์ตามนโยบายผู้ดูแล,
หยุด API/worker เดิม แล้วรัน migrate ด้วย imageใหม่ก่อนเริ่ม APIใหม่.
รุ่นปัจจุบันมี migrations001–013; คำสั่งใช้ checksum ตรวจประวัติและทำ transaction.
ห้ามแก้ SQLเก่า หรือเปิด workerเก่ากับ schemaใหม่พร้อมกัน. ไม่รองรับ SQL downgrade.
ถ้าต้องย้อนกลับ ให้คืนทั้ง backupและ imageที่ตรงกัน ไม่แก้ snapshotที่ publishแล้ว.

Model4–14ยังใช้ envelopeของเดิม; model15–16ใช้ dataร่วมและ sectionsแยกชุด.
การอัปเกรด software ไม่แปลงแม่แบบหรือเปลี่ยน versionที่เคย publish.
GET contract?version=... และ POST /jobs ที่ส่ง versionชัดเจนใช้แม่แบบชุดเดียวกัน.
การทดสอบ local Docker ไม่ใช่การรับรองเครื่องสะอาด, production load หรือ SLA.


## 0.2.9: รูปแบบและเวลาสร้างเอกสาร

ใช้ Core0.2.9 จาก vendor/manifest.json. ตัวเลือกหน้าปกที่นับเลขแต่ซ่อนหัวท้าย,
hัวท้ายอิงขอบหน้าจริง, Line/สีตาราง, textAlign ในเซลล์และหัวท้าย,
pageFieldLayout:compact เป็นค่าของแม่แบบ; ผู้เรียกยังส่งข้อมูลตาม contract เดิม.
อ่านรูปแบบ props และ model gates ในคู่มือ Core. ไม่ต้องเพิ่มฟิลด์ใน API
หรือ migration จาก0.2.0; snapshot เดิมไม่ถูกแปลงหรือแก้โดยอัปเกรด package.

ผลทดลอง local ของ SRS หนึ่งแม่แบบ85หน้า: ส่งรูปใหม่17ไฟล์และเรียก API ทีละงาน10รอบ
สำเร็จทั้งหมด; เวลาจากเริ่มอัปโหลดจนดาวน์โหลดเสร็จเฉลี่ย91.66วินาที,
ส่วนเบี่ยงเบนมาตรฐานแบบตัวอย่าง3.53วินาที, ช่วง87.68–99.52วินาที.
ใช้ i9-13900H, Docker Linux20 CPUs/ประมาณ7.61GiB, ไม่ใช่ SLA หรือผลทดสอบงานพร้อมกัน.
ทุกไฟล์ข้อความตรงกัน; มี IMAGE_LOW_RESOLUTION8จุดเดิม ต้องอ่าน warnings ด้วย.
ข้อมูลจริง/รูปของผู้ใช้ไม่ได้บรรจุใน repo หรือ image.

การทดลองตั้ง EXPORT_RENDER_TIMEOUT_MS=300000 ผ่าน Compose override;
ค่าปกติของ server ยังคง120000ms. การใส่ชื่อนี้ใน .env อย่างเดียวไม่ส่งเข้า container
เพราะ compose.yaml ยังไม่ได้ map ตัวเลือกนี้. หากต้องปรับให้สร้าง override:

```yaml
services:
  api:
    environment:
      EXPORT_RENDER_TIMEOUT_MS: "300000"
```

แล้วใช้ `docker compose -f compose.yaml -f compose.timeout.yaml up -d api`
ร่วมกับ env/project เดิม. เพิ่มเวลารอไม่ได้ลดเวลา render หรือรับประกันว่าเล่มใหญ่จะสำเร็จ.
รูปความละเอียดต่ำไม่ถูกขยายพิกเซลให้คมขึ้น; ชื่อปกยาวเกินหน้าจะ fail ตามกติกา.
ยังไม่รองรับ DOCX, custom font, Columns/ตารางซ้อนในcell หรือเลขหัวข้ออัตโนมัติ.


## 0.2.10: ลดต้นทุนการวัดข้อความ

ใช้ Core0.2.10 ตาม vendor/manifest.json. Core ใช้ตัวจัดรูปอักษรต่อเนื่องแยกตาม
ฟอนต์ภายในหนึ่งงาน พร้อม cache ที่จำกัดขนาด และปิดตัวทำงานเมื่อสำเร็จหรือล้มเหลว
ผู้เรียก API ไม่ต้องเปลี่ยนข้อมูล แม่แบบ หรือการตั้งค่า การ wrap ยังคงใช้กฎเดิม
ผลวัด0.2.9 ด้านบนเป็น baseline เก่า ไม่ใช่เวลาของรุ่นนี้ และไม่ใช่ SLA
การขึ้น release แยกจากการปรับรุ่นพัฒนา

## 0.2.11: ลดข้อมูลเตรียมฟอนต์

ส่งเฉพาะ glyph IDs ที่ใช้จริงแยกตามฟอนต์ไปยังตัวเตรียมฟอนต์
รูปแบบเอกสารและการ wrap คงเดิม ค่า cache ยังเป็น 32 MiB และยังไม่ขึ้น release

<a id="row-groups-0213"></a>
## 0.2.13: บริษัทและสมาชิกหลายรายการในหนึ่งตาราง

ผู้สร้างกำหนด array สองระดับใน Core model17 และ rowGroups ในแม่แบบ;
ผู้เรียก API ส่งเฉพาะข้อมูล ไม่ส่งกราฟ node หรือคำสั่งแบ่งหน้า.
ตัวอย่างนี้ต้องใช้ registry ทดลองที่ยังไม่มี `tpl-srs-basic` / `srs-basic`:

```powershell
docker @dc run --rm registry migrate
docker @dc run --rm registry draft-import examples/row-groups-template.json
docker @dc run --rm registry publish tpl-srs-basic row-groups-first
Invoke-RestMethod "$base/templates/srs-basic/contract?version=1"
```

ส่ง request โดยตรึง version ที่ publish แล้ว เช่น:

```json
{
  "docKey": "srs-basic", "version": 1, "data": {},
  "sections": {"main": {"content": [{
    "format": "meeting",
    "data": {"companies": [
      {"name": "บริษัท A", "members": [
        {"name": "ผู้เข้าร่วมคนที่หนึ่ง", "position": "ผู้ทดสอบ"},
        {"name": "ผู้เข้าร่วมคนที่สอง", "position": "ผู้พัฒนา"}
      ]},
      {"name": "บริษัท B", "members": []}
    ]}
  }]}}
}
```

POST /jobs → อ่าน GET /jobs/{jobId} จน succeeded → GET /jobs/{jobId}/pdf
เหมือนขั้นตอนแรกของคู่มือ. บริษัท B ยังมีชื่อ หัวคอลัมน์ และ empty row ตาม
แม่แบบ; companies=[] จะไม่มีชุดบริษัท. required ที่ไม่ส่งให้422 แต่ [] ส่งได้.
null/ชนิดผิดให้422 พร้อม indexed path; key เกินที่ไม่รู้จักถูกละเลยพร้อม warning.
ไม่รองรับ array ชั้นที่สามหรือ arbitrary object field. Modelเก่ายังคงกฎเดิม.

ในแม่แบบตัวอย่างเปิด `pagination.keepStart: true`: ชื่อบริษัท/หัวคอลัมน์
อยู่กับส่วนเริ่มต้นของสมาชิกคนแรก ส่วนที่เหลือแบ่งต่อหน้าได้. ถ้าชุดเริ่มต้นสูง
เกินหน้าจะผ่อนกติกาและคืน ROW_GROUP_KEEP_START_RELAXED ใน warnings ของ job
พร้อม groupId/groupIndex, nodeId/path และบริบท Section/รูปแบบ. ไม่ใช่ error
และไม่แปลว่าข้อมูลถูกตัด. ถ้าเนื้อหาแบ่งไม่ได้และใหญ่เกินหน้า ยังเป็น LAYOUT_FAILED.
EXPANSION_LIMIT หมายถึงผลขยายเกิน100,000 node/inline identities ให้422
ก่อนสร้าง job. อย่าส่งซ้ำแบบเดิมโดยคาดว่าระบบจะหายล่ม.

## อัปเกรดจาก 0.2.9–0.2.13 เป็น 0.2.14

1. หยุดรับงานใหม่และรอ queued/running ให้จบก่อนหยุด API; สำรองฐานข้อมูลตาม
   วิธีดูแลระบบของตน อย่าลบ volume เพื่ออัปเกรด.
2. เลือกโค้ด0.2.14 พร้อม vendor/manifest.json และ lockfile ของชุดเดียวกัน.
   เปลี่ยน FLOWDOC_REGISTRY_IMAGE ใน env เป็น imageชื่อใหม่ เช่น
   `flowdoc-service:manual-0.2.14` แล้ว build ไม่เขียนทับ image เดิม.
3. ใช้ Docker project/รหัสผ่าน/volume เดิม เรียก migrate ด้วย image0.2.14:

```powershell
docker @dc stop api
docker @dc build registry
docker @dc up -d --wait db
docker @dc run --rm registry migrate
docker @dc up -d --force-recreate api
Invoke-RestMethod "$base/health"
```

migrate ใช้ checksum และ transaction; รุ่น0.2.9–0.2.11 มีถึง012 จึงเพิ่ม013,
รุ่น0.2.12–0.2.13ที่ใช้ migration013แล้วจะไม่มีรายการใหม่. ไม่แก้ published snapshot
ไม่เปลี่ยน template model ให้อัตโนมัติ และไม่ต้อง import แม่แบบเก่าซ้ำ.
หากใช้ env manual ตามคู่มือนี้ `$dc` ต้องยังชี้ไฟล์/projectเดิม. คำสั่งนี้ไม่มี
rollback migration อัตโนมัติ; ไม่ควรเปิด imageเก่ากับแม่แบบmodel17ใหม่.

ตรวจ vendor ด้วย `node scripts/verifyVendor.mjs`. คำสั่ง
`npm run check:database` สร้าง DBทดลองใหม่เพื่อตรวจ migrations001–013,
CLI/publish/constraints/restart โดยไม่ทดสอบกับ DBจริง. ผลอยู่ artifacts/<run>;
ตามพฤติกรรมสคริปต์นี้ volume/imageยังเก็บไว้หลังหยุด ให้ลบเฉพาะprojectทดลอง
ที่ตรวจชื่อแล้วเมื่อตรวจผลเสร็จ. ทางเลือกตรวจ suite พร้อม cleanupอัตโนมัติคือ
`node scripts/checkRowGroups.mjs`.

รุ่นนี้รวมการลดต้นทุน shaping/font preparation ใน0.2.10–0.2.11 และกลุ่มแถว
ใน0.2.12–0.2.13. ไม่รวม autoLink, DOCX, Editor, การเยื้องหัวข้อใหม่ หรือการเพิ่ม
workerพร้อมกัน. เวลาที่วัดจากเล่มทดลองเป็นข้อมูลเครื่อง/ชุดข้อมูลนั้น ไม่ใช่ SLA.


## 0.2.14: คิวเต็มและงานล้มเหลว

รุ่น 0.2.14 รวมการจำกัดคิวและการจัดการงานที่ถูกขัดจังหวะดังนี้
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

## 0.2.14: หน่วยความจำและผลทดสอบเอกสารยาว

Service ลดข้อมูลซ้ำที่ส่งให้ตัวสร้าง PDF และ Core คำนวณลายนิ้วมือเอกสาร
ทีละส่วนแทนการสร้าง JSON ทั้งเล่ม โดยคงการตรวจข้อมูล รูปแบบหน้าและลิงก์เดิม
ผู้เรียกใช้ request และแม่แบบเดิมได้ ไม่ต้องเปิด option เพิ่ม

ผลจากชุดทดลองวันที่ 13 ตุลาคม 2026 บนโค้ดเดียวกันก่อนเปลี่ยนเลขรุ่น:

| ชุดทดลอง | RAM สูงสุดแบบ working set | เวลา worker |
| --- | ---: | ---: |
| 98 หน้า ก่อนลด JSON ใน Core | 362.29 MiB | 11.17 วินาที |
| 98 หน้า หลังลด JSON ใน Core | 357.12 MiB | 11.64 วินาที |
| 483 หน้า หลังลด JSON ใน Core | 642.90 MiB | 56.07 วินาที |

98 หน้าเป็นการเทียบก่อน–หลังหนึ่งคู่ด้วยตัววัดภายนอกทุก200ms; 483หน้าเป็น
การยืนยันหลังแก้หนึ่งครั้ง ไม่ใช่ผลเทียบก่อน–หลังใหม่ของเล่มใหญ่
working set เป็นค่าของ container API ซึ่งรวมโปรเซสลูกและตัวเก็บข้อมูล แต่ไม่รวม DB
การสุ่มวัดอาจไม่เห็นพีคสั้นมาก และค่าหน่วยความจำรวมของระบบยังรวมแคชไฟล์
จึงไม่ควรใช้ตัวเลขนี้เป็นเพดานจำนวนหน้า/RAM, SLA หรือขนาดเครื่องขั้นต่ำ

ทั้งสองขนาดผ่านการเทียบคำสั่งวาด ฟอนต์ รูปภาพ ขนาดหน้า ข้อมูล และลิงก์กับ
ไฟล์อ้างอิงครบ ไม่พบ OOM หรือตัวเฝ้าระวังสั่งหยุด ข้อมูลชุด483หน้าครบ
7,285ค่า / 1,815รายการ / 1,956ลิงก์ภายใน การจัดหน้าบางส่วนและบัฟเฟอร์ PDF
ยังอยู่ในหน่วยความจำจนใช้เสร็จ ระบบยังทำงานทีละเล่ม ไม่ใช่ streaming ทั้งระบบ

ตัวอย่างทดลองใช้ API container1GiB/2CPU และ DB256MiB; นี่เป็นเงื่อนไขของ
การทดลอง ไม่ใช่ข้อจำกัดที่ Compose ตั้งให้โดยอัตโนมัติ งาน700หน้าและการเพิ่ม
workerพร้อมกันยังไม่ได้รับการยืนยัน งานลด RAM เพิ่มเติมพักไว้หลังรุ่นนี้
