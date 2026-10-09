import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {migrate} from '../dist/db/migrate.js';
const root=await mkdtemp(join(tmpdir(),'flowdoc-large-')),schema='large_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:process.env.DATABASE_URL});await admin.query('CREATE SCHEMA '+schema);
const connection=new URL(process.env.DATABASE_URL);connection.searchParams.set('options','-c search_path='+schema);
const pool=new Pool({connectionString:connection.toString()});assert.equal((await migrate(pool)).ok,true);
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let c=0xffffffff;for(const b of body)c=crcTable[(c^b)&255]^(c>>>8);const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((c^0xffffffff)>>>0,out.length-4);return out;}
// Valid 4K RGB PNG with incompressible pixels, not transport bytes mislabeled as an image.
const width=3840,height=2160,raw=Buffer.alloc(height*(1+width*3));
for(let y=0;y<height;y++)randomBytes(width*3).copy(raw,y*(1+width*3)+1);
const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
assert(png.length>10*1048576);const file=join(root,'4k.png');await writeFile(file,png);
let child;const port=34987,base='http://127.0.0.1:'+port;
async function start(){child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,DATABASE_URL:connection.toString(),HOST:'127.0.0.1',PORT:String(port),UPLOAD_STAGING_DIR:join(root,'staging'),EXPORT_OUTPUT_DIR:join(root,'outputs'),EXPORT_TEMP_DIR:join(root,'temp')},stdio:['ignore','ignore','inherit']});for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('Server exited');try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Startup timeout');}
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Shutdown timeout'));},20000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}}
async function json(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});assert(r.ok,await r.clone().text());return (await r.json()).value;}
const rss=async()=>Number((await readFile('/proc/'+child.pid+'/status','utf8')).match(/^VmHWM:\s+(\d+)/m)[1])*1024;
try{
 const memoryLimit=Number((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim());assert.equal(memoryLimit,768*1048576,'Expected hard cgroup budget including fixture client and server');
 await start();const before=await rss();
 const s=await json('/uploads',{requestKey:'4k-live',items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:png.length},{key:'b',source:'upload',mediaType:'image/png',byteSize:png.length}]});
 const result=await Promise.all(s.items.map(async i=>{const r=await fetch(base+'/uploads/'+s.uploadId+'/items/'+i.resourceId+'/content',{method:'PUT',headers:{'content-type':'image/png'},body:createReadStream(file),duplex:'half'});assert.equal(r.status,200);await r.arrayBuffer();}));
 const ready=await json('/uploads/'+s.uploadId+'/finalize',{});assert.equal(ready.status,'ready');assert.equal(ready.received,2);
 const peak4k=await rss();
 const wide=5120,tall=3200,largeRaw=Buffer.alloc(tall*(1+wide*3));
 for(let y=0;y<tall;y++)randomBytes(wide*3).copy(largeRaw,y*(1+wide*3)+1);
 const largeHeader=Buffer.from(header);largeHeader.writeUInt32BE(wide);largeHeader.writeUInt32BE(tall,4);
 const largePng=Buffer.concat([png.subarray(0,8),chunk('IHDR',largeHeader),chunk('IDAT',deflateSync(largeRaw)),chunk('IEND',Buffer.alloc(0))]);
 const largeFile=join(root,'large.png');await writeFile(largeFile,largePng);
 const large=await json('/uploads',{requestKey:'large-live',items:[{key:'a',source:'upload',mediaType:'image/png',byteSize:largePng.length},{key:'b',source:'upload',mediaType:'image/png',byteSize:largePng.length}]});
 await Promise.all(large.items.map(async i=>{const r=await fetch(base+'/uploads/'+large.uploadId+'/items/'+i.resourceId+'/content',{method:'PUT',headers:{'content-type':'image/png'},body:createReadStream(largeFile),duplex:'half'});assert.equal(r.status,200);await r.arrayBuffer();}));
 assert.equal((await json('/uploads/'+large.uploadId+'/finalize',{})).status,'ready');
 const peak=await rss();assert(peak<256*1048576,'Intake RSS exceeds experiment budget');
 await stop();await start();assert.equal((await json('/uploads/'+s.uploadId)).status,'ready');assert.equal((await json('/uploads/'+large.uploadId)).status,'ready');
 console.log(JSON.stringify({status:'PASS',images:[{width,height,bytes:png.length},{width:wide,height:tall,bytes:largePng.length}],simultaneousFiles:result.length,serverPeakRssBefore:before,serverPeakRss4k:peak4k,serverPeakRssAfter:peak,rssBudgetBytes:256*1048576,checks:['valid large PNG originals','two simultaneous binary streams','finalize','server restart preserves receipts'],boundary:'Intake only; no decode/downsample or load-capacity claim'}));
}finally{await stop();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
