import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'flowdoc-cli-')),file=join(dir,'draft.json');
function cli(args,success=true){const r=spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8',env:process.env});const v=JSON.parse(r.stdout);assert.equal(v.ok,success,JSON.stringify(v));assert.equal(r.status,success?0:1);return v.value;}
const t=JSON.parse(readFileSync('examples/srs-template.json','utf8'));t.templateId='tpl-cli-current';t.docKey='cli-current';writeFileSync(file,JSON.stringify(t));cli(['draft-import',file]);
let record=cli(['draft-show',t.templateId]);record.payload.name='CLI edited';writeFileSync(file,JSON.stringify(record));cli(['draft-save',file]);
const v1=cli(['publish',t.templateId,'cli-first']);assert.equal(v1.version,1);assert.equal(cli(['publish',t.templateId,'cli-first']).versionId,v1.versionId);
record=cli(['draft-show',t.templateId]);const saved=structuredClone(record);record.variables=record.variables.filter(v=>v.key!=='projectName');writeFileSync(file,JSON.stringify(record));cli(['draft-save',file]);cli(['publish',t.templateId,'cli-next'],false);
saved.revision=cli(['draft-show',t.templateId]).revision;writeFileSync(file,JSON.stringify(saved));cli(['draft-save',file]);assert.equal(cli(['publish',t.templateId,'cli-next']).version,2);assert.equal(cli(['show',t.docKey,'1']).versionId,v1.versionId);
console.log(JSON.stringify({status:'PASS',versionId:v1.versionId,checks:['CLI import/show/save','publish retry','invalid draft rejected','repair and version2','old version readable']}));
