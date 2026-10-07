import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const manifest=JSON.parse(readFileSync(new URL('../vendor/manifest.json',import.meta.url),'utf8'));
const bytes=readFileSync(new URL('../vendor/'+manifest.file,import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256,'Core artifact checksum mismatch');
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
assert.equal(pkg.dependencies['@flowdoc/core'],'file:vendor/'+manifest.file);
console.log('Core artifact identity PASS');
