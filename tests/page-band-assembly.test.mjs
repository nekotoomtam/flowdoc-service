import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {decompose,assemble,checkRecord} from '../dist/templates/assembly.js';
const fixture=()=>{const t=JSON.parse(readFileSync('examples/cover-pages-template.json','utf8'));t.nodeModelVersion=14;for(const k of ['header','footer'])t[k]={inputSchema:{type:'object',fields:{projectName:{type:'string'}}},baseTextStyleId:'body',fragment:{rootIds:[],nodes:{}}};return t;};
it('normalizes independent schema owners and reconstructs both bands',()=>{const t=fixture(),r=decompose(t,randomUUID);expect(r.schemas.filter(s=>s.scope==='header')).toHaveLength(1);expect(r.schemas.filter(s=>s.scope==='footer')).toHaveLength(1);expect(r.payload.header).not.toHaveProperty('inputSchema');expect(assemble(r,1)).toEqual(t);const h=r.schemas.find(s=>s.scope==='header');r.variables.find(v=>v.schemaId===h.id).key='headerName';expect(assemble(r,1).header.inputSchema.fields.headerName).toBeDefined();expect(assemble(r,1).globalSchema.fields.projectName).toBeDefined();});
it('rejects duplicate scoped owners and cross-boundary owner references',()=>{const r=decompose(fixture(),randomUUID),h=r.schemas.find(s=>s.scope==='header');expect(h).toBeDefined();r.schemas.push({...h,id:randomUUID()});expect(()=>checkRecord(r)).toThrow();});
