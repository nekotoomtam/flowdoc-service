import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
const id=Date.now(),project='flowdoc-upload-'+id,output=join('artifacts',String(id));mkdirSync(output,{recursive:true});
const env=join(output,'compose.env');writeFileSync(env,`FLOWDOC_DB_PASSWORD=${randomBytes(24).toString('hex')}\nFLOWDOC_REGISTRY_IMAGE=flowdoc-upload-runtime:${id}\nFLOWDOC_VERIFY_IMAGE=flowdoc-upload-tests:${id}\n`);
const run=args=>execFileSync('docker',['compose','--env-file',env,'-p',project,...args],{encoding:'utf8',maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
try{
 writeFileSync(join(output,'build.log'),run(['build','verification']));run(['up','-d','--wait','db']);
 const result=JSON.parse(run(['run','--rm','-T','--entrypoint','node','verification','tests/upload-large-live.mjs']));
 if(result.status!=='PASS')throw Error('Large input verification failed');
 const image=execFileSync('docker',['image','inspect','flowdoc-upload-tests:'+id,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
 const report={...result,project,image,output};writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(e){writeFileSync(join(output,'failure.log'),String(e.stdout??'')+'\n'+String(e.stderr??e.message));process.exitCode=1;console.error('Upload check failed; inspect '+output);}
finally{run(['stop']);}
