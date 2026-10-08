import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
function call(args,env={}){return spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8',env:{...process.env,DATABASE_URL:'',...env}});}
it('shows commands without needing DB configuration',()=>{const r=call(['--help']);expect(r.status).toBe(0);expect(r.stdout).toContain('register');});
it('returns sanitized errors for invalid arguments and missing DB config',()=>{
 const missing=call(['migrate']);expect(missing.status).toBe(1);expect(JSON.parse(missing.stdout)).toMatchObject({ok:false,issues:[{code:'CONFIGURATION_ERROR'}]});
 for(const args of [['wrong'],['show','key','1junk'],['show','key','0'],['register'],['migrate','extra']]){const r=call(args);expect(r.status).toBe(1);expect(JSON.parse(r.stdout)).toMatchObject({ok:false,issues:[{code:'INVALID_ARGUMENT'}]});}
 const secret=call(['migrate'],{DATABASE_URL:'not-a-valid-url-private-secret'});expect(secret.status).toBe(1);expect(secret.stdout+secret.stderr).not.toContain('private-secret');
});
it('documents draft and publication commands with strict arguments',()=>{const r=call(['--help']);expect(r.stdout).toContain('draft-import');expect(r.stdout).toContain('publish');for(const args of [['publish','id'],['draft-show'],['draft-save']])expect(JSON.parse(call(args).stdout)).toMatchObject({ok:false,issues:[{code:'INVALID_ARGUMENT'}]});});
