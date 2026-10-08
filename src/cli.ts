import {readFile} from 'node:fs/promises';
import {createPool} from './db/connection.js';
import {migrate} from './db/migrate.js';
import {registerTemplate,loadTemplate} from './templates/registry.js';
import {importCurrent,loadCurrent,saveCurrent} from './templates/current.js';
import {publishCurrent} from './templates/publish.js';
import {OperationError,failure} from './errors.js';
import type {Result} from '@flowdoc/core';
async function main():Promise<Result<unknown>>{
 const [command,...args]=process.argv.slice(2);
 const commands=['migrate','register <raw-template.json>','show <docKey> [version]','draft-import <raw-template.json>','draft-show <templateId>','draft-save <current-record.json>','publish <templateId> <requestId>'];
 if(command==='--help'&&args.length===0)return {ok:true,value:{commands},warnings:[]};
 if(!(command==='migrate'&&args.length===0||['register','draft-import','draft-show','draft-save'].includes(command??'')&&args.length===1||command==='publish'&&args.length===2||command==='show'&&(args.length===1||args.length===2)))throw new OperationError('INVALID_ARGUMENT','command','Use --help for command syntax');
 let version:number|undefined;
 if(command==='show'&&args.length===2){if(!/^[1-9]\d*$/.test(args[1]!))throw new OperationError('INVALID_ARGUMENT','version','Version must be a positive integer');version=Number(args[1]);if(!Number.isSafeInteger(version)||version>2147483647)throw new OperationError('INVALID_ARGUMENT','version','Version exceeds supported range');}
 const url=process.env.DATABASE_URL;if(!url)throw new OperationError('CONFIGURATION_ERROR','database','DATABASE_URL is required');
 const pool=createPool(url);pool.on('error',()=>{});
 try{
  if(command==='migrate')return await migrate(pool);
  if(command==='show')return await loadTemplate(pool,args[0]!,version);
  if(command==='draft-show')return await loadCurrent(pool,args[0]!);
  if(command==='publish')return await publishCurrent(pool,{templateId:args[0]!,requestId:args[1]!});
  let raw:string;try{raw=await readFile(args[0]!,'utf8');}catch{throw new OperationError('INPUT_UNAVAILABLE','template','Template file could not be read');}
  if(command==='draft-import')return await importCurrent(pool,raw);
  if(command==='draft-save'){let r:any;try{r=JSON.parse(raw);}catch{throw new OperationError('INVALID_DATA','record','Invalid JSON');}return await saveCurrent(pool,r,r?.revision);}
  return await registerTemplate(pool,raw);
 }finally{await pool.end();}
}
const result=await main().catch(failure);process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
