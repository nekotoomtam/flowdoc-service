import {Pool} from 'pg';
import type {PoolClient} from 'pg';
export function createPool(connectionString:string):Pool {
 const pool=new Pool({connectionString,max:8,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:15000});
 // pg removes its idle error listener during checkout. Keep a listener for the
 // whole client lifetime, including the rollback/disposal of a broken socket.
 // Query promises still reject; domain listeners (such as leadership loss) run.
 pool.on('connect',client=>{client.on('error',()=>{});});
 // pg has already removed an idle broken client before emitting this event.
 pool.on('error',()=>{});
 return pool;
}
export async function transaction<T>(pool:Pool,operation:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();let discard=false;
 try {await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
 catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
 finally{client.release(discard);}
}
