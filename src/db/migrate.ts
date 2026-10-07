import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import type {Pool} from 'pg';
import type {Result} from '@flowdoc/core';
import {transaction} from './connection.js';
import {OperationError,failure} from '../errors.js';
const directory=fileURLToPath(new URL('../../migrations/',import.meta.url));
export async function migrate(pool:Pool,location=directory):Promise<Result<{applied:string[]}>>{
 try{
  const names=(await readdir(location)).filter(n=>/^\d{3}_[a-zA-Z0-9_-]+\.sql$/.test(n)).sort();
  if(!names.length)throw new OperationError('MIGRATION_MISMATCH','migrations','No migration files found');
  const files=await Promise.all(names.map(async name=>{const sql=await readFile(join(location,name),'utf8');return {name,sql,checksum:createHash('sha256').update(sql).digest('hex')};}));
  const applied=await transaction(pool,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(60430403)');
   await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
   const previous=await client.query<{name:string;checksum:string}>('SELECT name,checksum FROM schema_migrations ORDER BY name');
   for(const [i,row] of previous.rows.entries())if(files[i]?.name!==row.name||files[i]?.checksum!==row.checksum)throw new OperationError('MIGRATION_MISMATCH','migrations','Applied migration history differs from this release');
   const done:string[]=[];
   for(const file of files.slice(previous.rows.length)){await client.query(file.sql);await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[file.name,file.checksum]);done.push(file.name);}
   return done;
  });return {ok:true,value:{applied},warnings:[]};
 }catch(error){return failure(error);}
}
