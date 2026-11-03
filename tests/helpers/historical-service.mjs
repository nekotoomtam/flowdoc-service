// Offline migration evidence only. Product code never imports a legacy SDK.
import {readFileSync} from 'node:fs';
import {mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';
import {migrate} from '../../dist/db/migrate.js';
export function legacyRoot(){const root=process.env.FLOWDOC_LEGACY_SERVICE_ROOT;if(!root)throw Error('Frozen legacy Service test mount required (offline migration evidence only)');return root;}
export function legacyTemplate(name){return JSON.parse(readFileSync(join(legacyRoot(),name),'utf8'));}
export async function legacyModule(name){return import(pathToFileURL(join(legacyRoot(),'dist',name+'.js')).href);}
export async function legacyCore(){return import(pathToFileURL(join(legacyRoot(),'node_modules/@flowdoc/core/dist/index.js')).href);}
export async function migrateThrough028(pool){const folder=await mkdtemp(join(tmpdir(),'flowdoc-historical028-'));try{for(const n of(await readdir('migrations')).filter(n=>/^\d{3}_/.test(n)&&n<'029_'))await copyFile(join('migrations',n),join(folder,n));const historical=await legacyModule('db/migrate');return await historical.migrate(pool,folder);}finally{await rm(folder,{recursive:true,force:true});}}
