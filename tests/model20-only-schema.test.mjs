import {it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assertRuntimeSchema} from '../dist/db/runtime-schema.js';
const required='029_model20_only.sql';
const catalog=()=>readdirSync('migrations').filter(n=>/^\d{3}_[a-zA-Z0-9_-]+\.sql$/.test(n)).sort().map(name=>({name,checksum:createHash('sha256').update(readFileSync('migrations/'+name)).digest('hex')}));
it('bundles additive029 after the checksum-stable historical prefix',()=>{const rows=catalog();expect(rows).toHaveLength(29);expect(rows.at(-1).name).toBe(required);});
it('refuses startup on028 without writing or repairing its ledger',async()=>{const rows=catalog().filter(r=>r.name!==required),before=structuredClone(rows),queries=[];await expect(assertRuntimeSchema({query:async sql=>{queries.push(sql);return{rows};}})).rejects.toMatchObject({code:'RUNTIME_SCHEMA_REQUIRED',path:'schema'});expect(rows).toEqual(before);expect(queries).toHaveLength(1);expect(queries[0]).toMatch(/^SELECT\b/);});
it('accepts the exact029 ledger and rejects its altered checksum',async()=>{const rows=catalog();expect(rows.at(-1).name).toBe(required);await expect(assertRuntimeSchema({query:async()=>({rows})})).resolves.toBeUndefined();const bad=structuredClone(rows);bad.at(-1).checksum='0'.repeat(64);await expect(assertRuntimeSchema({query:async()=>({rows:bad})})).rejects.toMatchObject({code:'RUNTIME_SCHEMA_REQUIRED'});});
