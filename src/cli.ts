import {readFile} from 'node:fs/promises';
import {createPool} from './db/connection.js';
import {migrate} from './db/migrate.js';
import {registerTemplate,loadTemplate} from './templates/registry.js';
import {OperationError,failure} from './errors.js';
import type {Result} from '@flowdoc/core';
async function main():Promise<Result<unknown>>{
 const [command,...args]=process.argv.slice(2);
 if(command==='--help'&&args.length===0)return {ok:true,value:{commands:['migrate','register <raw-template.json>','show <docKey> [version]']},warnings:[]};
 if(!(command==='migrate'&&args.length===0||command==='register'&&args.length===1||command==='show'&&(args.length===1||args.length===2)))throw new OperationError('INVALID_ARGUMENT','command','Use --help for command syntax');
 let version:number|undefined;
 if(command==='show'&&args.length===2){if(!/^[1-9]\d*$/.test(args[1]!))throw new OperationError('INVALID_ARGUMENT','version','Version must be a positive integer');version=Number(args[1]);if(!Number.isSafeInteger(version)||version>2147483647)throw new OperationError('INVALID_ARGUMENT','version','Version exceeds supported range');}
 const url=process.env.DATABASE_URL;if(!url)throw new OperationError('CONFIGURATION_ERROR','database','DATABASE_URL is required');
 const pool=createPool(url);pool.on('error',()=>{}); // Per-operation errors stay in Result; never print pool secrets.
 try{
  if(command==='migrate')return await migrate(pool);
  if(command==='show')return await loadTemplate(pool,args[0]!,version);
  let raw:string;try{raw=await readFile(args[0]!,'utf8');}catch{throw new OperationError('INPUT_UNAVAILABLE','template','Template file could not be read');}
  return await registerTemplate(pool,raw);
 }finally{await pool.end();}
}
const result=await main().catch(failure);process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=1;
