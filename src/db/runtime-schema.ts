import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {OperationError} from '../errors.js';

const required='028_model20_section_definitions.sql';
const directory=fileURLToPath(new URL('../../migrations/',import.meta.url));
const requiredError=()=>new OperationError('RUNTIME_SCHEMA_REQUIRED','schema','Required database schema is not available');
const unavailable=()=>new OperationError('RUNTIME_SCHEMA_UNAVAILABLE','schema','Runtime schema verification unavailable');

/** Read-only startup prerequisite; applying or repairing migrations remains an operator action. */
export async function assertRuntimeSchema(pool:Pick<Pool,'query'>,location=directory):Promise<void>{
 let expected:{name:string;checksum:string}[];
 try{
  const names=(await readdir(location)).filter(n=>/^\d{3}_[a-zA-Z0-9_-]+\.sql$/.test(n)).sort();
  if(names.at(-1)!==required||names.length!==28||names.some((name,i)=>!name.startsWith(String(i+1).padStart(3,'0')+'_')))throw Error();
  expected=await Promise.all(names.map(async name=>({name,checksum:createHash('sha256').update(await readFile(join(location,name))).digest('hex')})));
 }catch{throw unavailable();}
 let rows:{name:string;checksum:string}[];
 try{rows=(await pool.query<{name:string;checksum:string}>('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;}
 catch(error){if((error as {code?:string})?.code==='42P01')throw requiredError();throw unavailable();}
 if(rows.length!==expected.length||rows.some((row,i)=>row.name!==expected[i]!.name||row.checksum!==expected[i]!.checksum))throw requiredError();
}
