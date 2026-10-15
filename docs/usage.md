# คู่มือใช้งาน FlowDoc Service 0.3.0

## Authority Boundary

Owner: flowdoc-service. คู่มือนี้อธิบาย CLI, HTTP API และการทำงาน local ของโค้ด
รุ่น 0.3.0 ไม่ใช่การรับรอง production capacity; สถานะ release อยู่ใน Project Control
ขอบเขตและสถานะร่วมอยู่ใน flowdoc-project-control ที่
`docs/domains/flowdoc-page-system-roadmap-2026-10-10.md`
รูปแบบแม่แบบเป็นอำนาจของ Core ดู [คู่มือสร้างแม่แบบ](../../flowdoc-core/docs/template-guide.md)

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

ใช้ Docker Desktop แบบ Linux containers บนเครื่อง x64 และ PowerShell 7
เปิด terminal ในโฟลเดอร์ flowdoc-service ที่มีโค้ด 0.3.0
ไม่ต้องติดตั้งฐานข้อมูล Python หรือ Core แยกบนเครื่อง เพราะ image รวมไว้แล้ว
การ build ครั้งแรกต้องเชื่อมต่ออินเทอร์เน็ต

สร้างไฟล์ตั้งค่าทดลองครั้งเดียว เก็บไฟล์นี้ไว้ ไม่ส่งรหัสผ่านไปกับรายงาน:

```powershell
if (Test-Path .env.manual) { throw '.env.manual มีอยู่แล้ว ให้ใช้ไฟล์เดิม' }
$manualPassword = [guid]::NewGuid().ToString('N')
@(
  "FLOWDOC_DB_PASSWORD=$manualPassword"
  'FLOWDOC_REGISTRY_IMAGE=flowdoc-service:manual-0.3.0'
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

รุ่นนี้เป็น localhost ไม่มีสิทธิ์รายคน และมี coordinator เดียว ประมวลผลเอกสารเรียงกัน
หลัง restart งาน queued ทำต่อ แต่งาน running ที่ถูกตัดจบเป็น PROCESS_INTERRUPTED
รายละเอียด configuration และการทดสอบอยู่ใน [README](../README.md)
ยังไม่รวม DOCX, หน้าแก้ไขเอกสาร หรือ SLA งานพร้อมกันจำนวนมาก; ระบบหน้าและหัวท้ายใช้สัญญา Area18


## รูปแบบแม่แบบ Area 18

รุ่น 0.3.0 รับเฉพาะ `nodeModelVersion: 18` ไม่แปลง model4–17 อัตโนมัติ
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
