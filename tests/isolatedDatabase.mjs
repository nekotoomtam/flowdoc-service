import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
export function isolatedDatabase(){
 if(!process.env.DATABASE_URL)throw Error('Isolated DATABASE_URL required');
 const schema='r4_'+randomUUID().replaceAll('-','');
 const admin=new Pool({connectionString:process.env.DATABASE_URL});
 const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema});
 return {pool,async setup(){await admin.query('CREATE SCHEMA '+schema);},async close(){await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}};
}
