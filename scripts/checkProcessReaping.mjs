import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = {...process.env, FLOWDOC_DB_PASSWORD:'isolated-reaping-check'};
const docker = args => execFileSync('docker', args, {
  cwd:root, env, encoding:'utf8', windowsHide:true, timeout:60000,
});
const prefix = ['compose', '-p', `flowdoc-reaping-${Date.now()}`, '-f', resolve(root, 'compose.yaml')];
const config = JSON.parse(docker([...prefix, '--profile', 'verify', 'config', '--format', 'json']));
for (const name of ['registry', 'api', 'verification']) {
  assert.equal(config.services[name].init, true, `${name} must enable the child-process reaper`);
}
// Translate the resolved API init setting to Docker's equivalent flag. Use no
// Compose networks/volumes: this probe needs neither the DB nor application data.
const name = `flowdoc-reaping-${Date.now()}`;
try {
  const text = docker(['run', '--rm', '--init', '--network', 'none', '--name', name,
    '--memory', '1g', '--memory-swap', '1g', '--cpus', '2',
    '--entrypoint', 'node', '-v', `${resolve(root, 'tests/checkProcessReaping.mjs')}:/reaping-check.mjs:ro`,
    config.services.api.image, '/reaping-check.mjs']);
  const report = JSON.parse(text.trim());
  assert.equal(report.status, 'PASS');
  console.log(JSON.stringify({...report, checkedServices:['registry','api','verification']}));
} finally {
  try { docker(['rm', '-f', '-v', name]); } catch { /* --rm normally removed it already. */ }
}
