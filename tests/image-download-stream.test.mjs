import {it,expect,vi,beforeEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {Readable,PassThrough} from 'node:stream';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const state=vi.hoisted(()=>({responses:[],calls:[]}));
vi.mock('node:dns/promises',()=>({lookup:async()=>[{address:'8.8.8.8',family:4}]}));
vi.mock('node:https',()=>({request:(url,options,callback)=>{
 const req=new EventEmitter();state.calls.push({url:url.href,options});req.end=()=>queueMicrotask(()=>{
  const spec=state.responses.shift();if(!spec){req.emit('error',Error('No fixture'));return;}
  const response=spec.stalled?new PassThrough():Readable.from(spec.body??[]);response.statusCode=spec.status??200;response.headers=spec.headers??{};callback(response);if(spec.stalled)response.write(Buffer.from('partial'));
 });return req;
}}));
const {downloadImage}=await import('../dist/images/download.js');
beforeEach(()=>{state.responses=[];state.calls=[];});
it('pins the checked address, rechecks redirect destinations and keeps exact streamed bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'download-')),path=join(dir,'image.bin');
 state.responses=[{status:302,headers:{location:'https://images.example/a'}},{body:[Buffer.from('abc')]}];
 expect(await downloadImage('https://example.org/a',path)).toBe(3);expect((await readFile(path)).toString()).toBe('abc');expect(state.calls).toHaveLength(2);
 const options=state.calls[1].options;expect(options.agent).toBe(false);expect(options.headers.authorization).toBeUndefined();options.lookup('images.example',{all:true},(_err,ips)=>expect(ips).toEqual([{address:'8.8.8.8',family:4}]));
});
it('blocks a redirect to metadata and removes partial oversized downloads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'download-')),path=join(dir,'image.bin');state.responses=[{status:302,headers:{location:'https://169.254.169.254/latest'}}];
 await expect(downloadImage('https://example.org/a',path)).rejects.toThrow();expect(state.calls).toHaveLength(1);expect(await readdir(dir)).toEqual([]);
 state.responses=[{body:[Buffer.alloc(3),Buffer.alloc(3)]}];await expect(downloadImage('https://example.org/a',path,undefined,5)).rejects.toThrow();expect(await readdir(dir)).toEqual([]);
 const abort=new AbortController();abort.abort();await expect(downloadImage('https://example.org/a',path,abort.signal)).rejects.toThrow();
});
it('bounds redirect count',async()=>{const dir=await mkdtemp(join(tmpdir(),'download-'));state.responses=Array.from({length:5},()=>({status:302,headers:{location:'/again'}}));await expect(downloadImage('https://example.org/a',join(dir,'image.bin'))).rejects.toThrow('redirect');expect(state.calls).toHaveLength(4);});
it('terminates a stalled body on deadline or in-flight cancellation and removes partial files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stalled-')),path=join(dir,'image.bin');state.responses=[{stalled:true}];
 await expect(downloadImage('https://example.org/a',path,undefined,100,40)).rejects.toThrow();expect(await readdir(dir)).toEqual([]);
 const abort=new AbortController();state.responses=[{stalled:true}];const pending=downloadImage('https://example.org/a',path,abort.signal);const rejected=expect(pending).rejects.toThrow();
 for(let i=0;i<100&&!(await readdir(dir)).length;i++)await new Promise(r=>setTimeout(r,2));abort.abort();await rejected;expect(await readdir(dir)).toEqual([]);
});
