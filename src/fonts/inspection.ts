import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {OperationError} from '../errors.js';
import {FONT_LIMITS,type FontMetadata} from './types.js';
const execute=promisify(execFile);
let queue:Promise<void>=Promise.resolve();
/** Serialize parsers within a process; the import transaction also locks across workers. */
export async function inspectFont(path:string,options:{pythonExecutable?:string;timeoutMs?:number;includeHeightMetric?:boolean}={}):Promise<FontMetadata>{
 const previous=queue;let release!:()=>void;queue=new Promise<void>(r=>{release=r;});await previous;
 try{
  const {stdout}=await execute(options.pythonExecutable??process.env.PYTHON_EXECUTABLE??'python',
   [fileURLToPath(new URL('../../runtime/python/inspectFont.py',import.meta.url)),path,...(options.includeHeightMetric?['--height-metric']:[])],
   {encoding:'utf8',timeout:options.timeoutMs??FONT_LIMITS.parseMs,maxBuffer:2*FONT_LIMITS.metadataBytes,windowsHide:true});
  const value=JSON.parse(stdout) as FontMetadata;
  if(!Number.isInteger(value.rawWeight)||value.rawWeight<1||value.rawWeight>1000||!['normal','italic'].includes(value.style)||!Array.isArray(value.coverage)||!value.names?.family)throw Error('metadata');
  return value;
 }catch(error){
  const e=error as NodeJS.ErrnoException&{killed?:boolean};
  throw new OperationError(e.code==='ENOENT'?'FONT_INSPECTION_UNAVAILABLE':e.killed?'FONT_INSPECTION_TIMEOUT':'INVALID_FONT_FILE','font','Static TTF inspection did not succeed');
 }finally{release();}
}
