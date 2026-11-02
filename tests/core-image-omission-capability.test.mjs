import {it,expect,vi} from 'vitest';
vi.mock('@flowdoc/core',async original=>({...await original(),DOCX_IMAGE_OMISSIONS_CONTRACT:'unsupported'}));
vi.mock('../dist/db/connection.js',async original=>({...await original(),createPool:vi.fn(()=>{throw Error('Pool must not be acquired');})}));
import {startService} from '../dist/server.js';
import {createPool} from '../dist/db/connection.js';
it('refuses an incompatible Core before acquiring database or listener resources',async()=>{const old=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/unused';try{await expect(startService()).rejects.toMatchObject({code:'RENDERER_PIN_MISMATCH'});expect(createPool).not.toHaveBeenCalled();}finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;}});
