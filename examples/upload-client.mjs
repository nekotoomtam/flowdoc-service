import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const [file,type='image/png',base='http://127.0.0.1:3000']=process.argv.slice(2);
if(!file||!['image/png','image/jpeg'].includes(type))throw Error('Usage: node examples/upload-client.mjs <file> [image/png|image/jpeg] [baseUrl]');
async function call(path,options){const r=await fetch(base+path,options);const body=await r.json();if(!r.ok)throw Error(JSON.stringify(body));return body.value;}
const session=await call('/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestKey:randomUUID(),items:[{key:'image',source:'upload',mediaType:type,byteSize:(await stat(file)).size}]})});
await call('/uploads/'+session.uploadId+'/items/'+session.items[0].resourceId+'/content',{method:'PUT',headers:{'content-type':type},body:createReadStream(file),duplex:'half'});
console.log(JSON.stringify(await call('/uploads/'+session.uploadId+'/finalize',{method:'POST'}),null,2));
