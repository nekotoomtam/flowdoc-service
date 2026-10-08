import {it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {isolatedDatabase} from './isolatedDatabase.mjs';
import {migrate} from '../dist/db/migrate.js';
it('invalid startup configuration exits promptly with a usable migrated DB',async()=>{
 const db=isolatedDatabase();await db.setup();expect((await migrate(db.pool)).ok).toBe(true);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',db.pool.options.options);
 try{
 const child=spawn(process.execPath,['dist/server.js'],{env:{...process.env,DATABASE_URL:url.href,EXPORT_BODY_LIMIT_BYTES:'bad',EXPORT_TEMP_DIR:'/app/temp'},stdio:'ignore'});
 let timer;const exit=await Promise.race([new Promise(r=>child.once('exit',code=>r(code))),new Promise(r=>{timer=setTimeout(()=>{child.kill('SIGKILL');r('hung');},2500);})]);clearTimeout(timer);expect(exit).toBe(1);
 }finally{await db.close();}
});
