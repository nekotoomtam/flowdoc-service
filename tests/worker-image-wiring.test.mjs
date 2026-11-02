import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import * as images from '../dist/images/prepare.js';
import {fakeLauncher,deferred} from './helpers/worker-adapter-fixture.mjs';
import {prepareOwnedJobImages} from '../dist/images/job.js';
it('does not publish image success if cancelled while stop proof is pending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p2-image-abort-')),stop=deferred(),f=fakeLauncher({holdStop:stop.promise}),abort=new AbortController();const p=images.createImagePreparer(f.launcher)({sourcePath:join(root,'source'),outputDirectory:root,widthPt:72,heightPt:36,signal:abort.signal});const rejected=expect(p).rejects.toThrow('cancelled');await new Promise(r=>setTimeout(r,20));expect(f.trace.some(x=>x[0]==='stop')).toBe(true);abort.abort();stop.resolve();await rejected;await rm(root,{recursive:true,force:true});
});
it('retains image storage reservation and original unknown-stop error even if later DB progress would fail',async()=>{
 for(const failProgress of [false,true]){
  const deltas=[];let progress=0;const query=async(sql,args)=>{
   if(sql.includes('INSERT INTO job_processing')){progress++;if(failProgress&&progress>1)throw Error('DB unavailable');}
   if(sql.includes('SELECT upload_id'))return{rows:[{upload_id:'upload'}]};
   if(sql.includes('SELECT * FROM upload_items'))return{rows:[{source_kind:'upload',status:'received',storage_key:'source',checksum:'hash'}]};
   if(sql.includes('SELECT reserved_bytes'))return{rows:[{reserved_bytes:0,deleted_at:null}]};
   if(sql.includes(' AS held,'))return{rows:[{held:0,used:0,pool:null,legacy:0,outputs:0,legacy_used:0}]};
   if(sql.includes('coalesce(sum(reserved_bytes)'))return{rows:[{bytes:0}]};
   if(sql.includes('reserved_bytes=reserved_bytes+'))deltas.push(args[1]);return{rows:[]};
  };const pool={query,connect:async()=>({query,release(){}})},document={nodes:{p:{id:'p',type:'image',props:{resourceId:'r',width:{value:72,unit:'pt'},height:{value:36,unit:'pt'}}}}};
  await expect(prepareOwnedJobImages(pool,'job',document,{files:{jobDirectory:()=>'/tmp/p2-reservation',path:()=>'/tmp/source'},config:{setBytes:1e9,stagingBytes:1e9},prepare:async()=>{throw Object.assign(Error(),{code:'WORKER_STOP_UNCONFIRMED'});}},new AbortController().signal)).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});
  expect(deltas).toEqual([32*1048576]);expect(progress).toBe(1);
 }
});
it('binds before unchanged JSON image IPC and holds serial admission until confirmed stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p2-images-')),bind=deferred(),stop=deferred(),f=fakeLauncher({holdBind:bind.promise,holdStop:stop.promise});const prepare=images.createImagePreparer(f.launcher),input={sourcePath:join(root,'source'),outputDirectory:root,widthPt:72,heightPt:36};
 try{const p=prepare(input);await new Promise(r=>setTimeout(r,10));expect(f.trace.map(x=>x[0])).toEqual(['spawn','bind']);bind.resolve();await new Promise(r=>setTimeout(r,15));await expect(prepare(input)).rejects.toThrow('busy');expect(f.trace.find(x=>x[0]==='send')[1]).toMatchObject({source:input.sourcePath,width:200,height:100,widthPt:72,heightPt:36});stop.resolve();expect((await p).status).toBe('prepared');}finally{await rm(root,{recursive:true,force:true});}
});
it('retains poisoned image admission on unknown stop and rejects required default bypass',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p2-images-')),input={sourcePath:join(root,'source'),outputDirectory:root,widthPt:72,heightPt:36},prepare=images.createImagePreparer(fakeLauncher({unknown:true}).launcher);
 try{await expect(prepare(input)).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});await expect(prepare(input)).rejects.toMatchObject({code:'WORKER_STOP_UNCONFIRMED'});const old=process.env.FLOWDOC_WORKER_ISOLATION;process.env.FLOWDOC_WORKER_ISOLATION='required';try{await expect(images.prepareImage(input)).rejects.toMatchObject({code:'WORKER_IMAGE_PREPARER_REQUIRED'});}finally{if(old===undefined)delete process.env.FLOWDOC_WORKER_ISOLATION;else process.env.FLOWDOC_WORKER_ISOLATION=old;}}finally{await rm(root,{recursive:true,force:true});}
});
