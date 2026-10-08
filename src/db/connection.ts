import {Pool} from 'pg';
import type {PoolClient} from 'pg';
export function createPool(connectionString:string):Pool {
 return new Pool({connectionString,max:5,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:15000});
}
export async function transaction<T>(pool:Pool,operation:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();let discard=false;
 try {await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}
 catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
 finally{client.release(discard);}
}
