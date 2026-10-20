import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, readdir} from 'node:fs/promises';

// Run inside a fresh Linux container, under the same init setting as the API.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async pid => {
  try { await readFile(`/proc/${pid}/stat`); return true; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
};
const until = async condition => {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    assert(Date.now() < deadline, 'Owned process was not reaped within five seconds');
    await sleep(10);
  }
};
const workerSource = `
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const child = spawn('/app/node_modules/@flowdoc/core/runtime/linux-x64/flowdoc-icu4x-line-segmenter', ['--serve'], {stdio:['pipe','pipe','pipe']});
child.once('error', error => { throw error; });
await once(child.stdout, 'data');
process.send({pid:child.pid});
process.once('message', async () => {
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
  process.disconnect();
});
`;

const cases = [];
for (const mode of ['normal', 'forced']) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = spawn(process.execPath, ['--input-type=module', '-e', workerSource], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], detached: true,
    });
    const closed = once(worker, 'close');
    let nativePid;
    try {
      const message = await Promise.race([
        once(worker, 'message').then(([value]) => value),
        closed.then(() => { throw Error('Worker exited before native readiness'); }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Error('Native readiness timed out')), 5000);
          timer.unref();
        }),
      ]);
      nativePid = message.pid;
      assert(await exists(nativePid));
      if (mode === 'normal') worker.send({stop:true});
      else worker.kill('SIGKILL');
      const [code, signal] = await closed;
      if (mode === 'normal') assert.equal(code, 0);
      else assert.equal(signal, 'SIGKILL');
      await until(async () => !await exists(nativePid));
      await until(async () => !await exists(worker.pid));
      cases.push({mode, attempt, workerPid:worker.pid, nativePid, reaped:true});
    } finally {
      try { process.kill(-worker.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await closed;
    }
  }
}
const zombies = [];
for (const pid of await readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') zombies.push(Number(pid));
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
assert.deepEqual(zombies, []);
const init = (await readFile('/proc/1/cmdline', 'utf8')).split('\0')[0];
assert.notEqual(process.pid, 1, 'Service must run below a reaping init');
console.log(JSON.stringify({status:'PASS', init, pid:process.pid, cases, zombies}));
