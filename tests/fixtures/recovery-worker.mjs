import {Pool} from 'pg';
import {startProcessor} from '../../dist/jobs/processor.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:process.env.TEST_DB_OPTIONS});
await startProcessor({pool,policy:{retain:false,ttlHours:24},files:{writePdf:async()=>{throw Error('Unexpected write');}},render:async()=>{
 process.send({event:'rendering'});
 return new Promise(()=>{});
},pollMs:10});
