// Bounded acceptance probe: run in the packaged runtime with 512 MiB/no swap.
// Fixture generation is included in the cgroup peak, not attributed to the decoder.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {prepareImage} from '../dist/images/prepare.js';

const output=process.env.FLOWDOC_LIMIT_OUTPUT??'/tmp/image-limits';
await mkdir(output,{recursive:true});
sharp.cache(false);sharp.concurrency(1);
const rows=[];
for(const format of ['jpeg','png']){
 const sourcePath=join(output,'source.'+format);
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="8000"><rect width="5000" height="8000" fill="#164567" fill-opacity="0.6"/>${Array.from({length:80},(_,i)=>`<rect x="${i%2?0:2500}" y="${i*100}" width="2500" height="50" fill="#efab37"/>`).join('')}</svg>`;
 await sharp(Buffer.from(svg)).toFormat(format).toFile(sourcePath);
 const outputDirectory=join(output,format);const started=performance.now();
 const result=await prepareImage({sourcePath,outputDirectory,widthPt:720,heightPt:1440});
 assert.equal(result.status,'prepared',JSON.stringify(result));
 const meta=await sharp(result.image.path).metadata();
 assert.equal(meta.width,2000);assert.equal(meta.height,3200);
 assert.equal(meta.hasAlpha,format==='png');
 assert.equal(result.warnings.length,0);
 rows.push({format,inputPixels:40_000_000,targetBudget:8_000_000,outputPixels:meta.width*meta.height,elapsedMs:Math.round(performance.now()-started),bytes:result.image.byteSize,alpha:meta.hasAlpha});
}
const sourcePath=join(output,'over-limit.png');
await sharp({create:{width:5000,height:8001,channels:4,background:'#16456788'}}).png().toFile(sourcePath);
const rejectedDirectory=join(output,'rejected');
const rejected=await prepareImage({sourcePath,outputDirectory:rejectedDirectory,widthPt:144,heightPt:144});
assert.equal(rejected.status,'skipped');assert.equal(rejected.warnings[0].code,'IMAGE_UNUSABLE');
assert.deepEqual(await readdir(rejectedDirectory),[]);
await assert.rejects(prepareImage({sourcePath,outputDirectory:join(output,'target-over'),widthPt:720,heightPt:1441}),/target exceeds pixel budget/);
const cgroup=async name=>Number((await readFile('/sys/fs/cgroup/'+name,'utf8')).trim());
const report={status:'PASS',cases:rows,overInputPixels:40_005_000,overInput:'skipped without partial files',overTarget:'rejected before decode',memoryLimit:await cgroup('memory.max'),memoryPeakIncludingFixtureGeneration:await cgroup('memory.peak'),memoryEvents:await readFile('/sys/fs/cgroup/memory.events','utf8')};
assert.equal(report.memoryLimit,512*1024*1024);
assert.match(report.memoryEvents,/oom_kill 0/);
await writeFile(join(output,'result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
