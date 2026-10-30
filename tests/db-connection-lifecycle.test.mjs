import {beforeAll,afterAll,it,expect} from 'vitest';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';

const db=isolatedDatabase();
beforeAll(async()=>{await db.setup();expect((await migrate(db.pool)).ok).toBe(true);});
afterAll(()=>db.close());
async function connectionLoss(mode){
 const name='int01-'+mode+'-'+randomUUID();
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',db.pool.options.options);url.searchParams.set('application_name',name);
 const child=fork(new URL('./checkDbConnectionLoss.mjs',import.meta.url),[mode],{execArgv:[],env:{...process.env,DATABASE_URL:url.toString()},stdio:['ignore','pipe','pipe','ipc']});
 let stderr='',done;child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const ready=new Promise(resolve=>child.on('message',m=>{if(m.pid)resolve(m);if(m.done)done=m;}));
 const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Child probe timeout')),12000);timer.unref();child.once('exit',()=>clearTimeout(timer));});
 try{
  const first=await Promise.race([ready,timeout,exit.then(v=>{throw Error('Probe exited before ready: '+JSON.stringify(v));})]);
  const observed=(await db.pool.query('SELECT application_name FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()',[first.pid])).rows[0];expect(observed?.application_name).toBe(name);
  if(mode==='transaction')for(let i=0;i<100;i++){const r=(await db.pool.query("SELECT query FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'",[first.pid])).rows[0];if(r?.query.includes('pg_sleep'))break;await new Promise(r=>setTimeout(r,10));}
  expect((await db.pool.query('SELECT pg_terminate_backend($1) AS killed',[first.pid])).rows[0].killed).toBe(true);
  if(mode!=='transaction'){await new Promise(r=>setTimeout(r,150));if(child.connected)child.send({probe:true});}
  const result=await Promise.race([exit,timeout]);const password=decodeURIComponent(url.password);const safe=(password?stderr.replaceAll(password,'[redacted]'):stderr).slice(0,1200);
  expect(result, safe).toEqual({code:0,signal:null});expect(done).toMatchObject({done:true,healthy:true});
  if(mode==='transaction')expect(done).toMatchObject({rejected:true,calls:1});
  if(mode==='leader')expect(done.leaderReady).toBe(false);
 }finally{child.kill();await exit;}
}
it('rejects a terminated checked-out transaction without killing the process or replaying work',()=>connectionLoss('transaction'),15000);
it('discards an unexpectedly terminated idle connection and serves the next query',()=>connectionLoss('idle'),15000);
it('keeps leadership-loss readiness fail-closed while allowing other connections to recover',()=>connectionLoss('leader'),15000);
