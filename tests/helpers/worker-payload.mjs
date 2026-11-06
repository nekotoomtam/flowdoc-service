import {readFile,readdir,readlink,fstatSync} from 'node:fs';
import {promisify} from 'node:util';
import {spawn} from 'node:child_process';
const links=[];for(const n of await promisify(readdir)('/proc/self/fd')){try{links.push(await promisify(readlink)('/proc/self/fd/'+n));}catch{}}
if(links.some(x=>x.includes('cgroup.procs')))throw Error('migration descriptor leaked');
if(process.argv[2]==='task-render')process.once('message',m=>{process.send({...m,fenceIno:fstatSync(4).ino},()=>process.disconnect());});
else{let input='';for await(const b of process.stdin)input+=b;
 if(input==='hold'){const escaped=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});process.stdout.write(JSON.stringify({escapedPid:escaped.pid}));setInterval(()=>{},1000);}
 else process.stdout.write(JSON.stringify({pid:process.pid,kind:process.argv[2],input,migrationFd:false,unsafeEnvironment:Object.keys(process.env).some(k=>k.startsWith('LD_')||['PYTHONPATH','PYTHONHOME','NODE_OPTIONS','DATABASE_URL'].includes(k))}));}
