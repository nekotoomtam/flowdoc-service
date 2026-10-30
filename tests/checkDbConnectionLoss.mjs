import assert from 'node:assert/strict';
import {createPool,transaction} from '../dist/db/connection.js';
import {startProcessor} from '../dist/jobs/processor.js';

const pool=createPool(process.env.DATABASE_URL);
const mode=process.argv[2];
const probe=new Promise(resolve=>process.once('message',resolve));
const tell=value=>process.send(value);
try{
 if(mode==='transaction'){
  let calls=0,rejected=false;
  try{await transaction(pool,async client=>{calls++;tell({pid:client.processID,mode});await client.query('SELECT pg_sleep(20)');});}
  catch{rejected=true;}
  assert.equal(rejected,true);assert.equal(calls,1);
  assert.equal((await pool.query('SELECT 1 AS healthy')).rows[0].healthy,1);
  tell({done:true,rejected,calls,healthy:true});
 }else if(mode==='idle'){
  const client=await pool.connect(),pid=client.processID;await client.query('SELECT 1');client.release();tell({pid,mode});await probe;
  assert.equal((await pool.query('SELECT 1 AS healthy')).rows[0].healthy,1);tell({done:true,healthy:true});
 }else if(mode==='leader'){
  let pid;
  const processor=await startProcessor({pool,files:{writePdf:async()=>{throw Error('No job expected');}},policy:{retain:false,ttlHours:1,tempHours:1},pollMs:5,initialize:async client=>{pid=client.processID;}});
  try{assert.equal(processor.isReady(),true);tell({pid,mode});await probe;
   for(let i=0;i<100&&processor.isReady();i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(processor.isReady(),false);assert.equal((await pool.query('SELECT 1 AS healthy')).rows[0].healthy,1);
  }finally{await processor.stop();}
  tell({done:true,healthy:true,leaderReady:false});
 }else throw Error('Unknown probe');
}finally{await pool.end();process.disconnect();}
