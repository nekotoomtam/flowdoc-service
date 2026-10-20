import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { transaction } from '../db/connection.js';
import { quotaLock, taskError } from './quota.js';
import { workspaceSize, clearWorkspace, groupStopped } from './workspace.js';
import {taskReadBudget} from './read-cache-budget.js';
import {taskPolicy} from './policy.js';
import type { createTaskIntake } from './intake.js';
type Context = Awaited<ReturnType<typeof createTaskIntake>>['processingContext'];
export interface GenerationSummary {
    version: 1;
    scope: 'expanded-image-nodes';
    imagePlacementCount: number;
    normalizedOmittedPlacementCount: number;
    preparationOmittedPlacementCount: number;
    omittedPlacementCount: number;
    findingCount: number;
    formatOmissionCount: number;
    completeness: 'complete' | 'partial';
}
export interface TaskRenderReceipt {
    summary: GenerationSummary;
    output: string;
    receipt: {
        byteLength: number;
        sha256: string;
        pageCount: number;
    };
    warnings: any[];
    warningCount: number;
}
export function fontWorkspaceBound(snapshot: any) {
    const fonts = 4 + new Set(snapshot.bindings.map((b: any) => [b.releaseId, b.weight, b.style].join(':'))).size;
    const licenses = snapshot.bindings.reduce((n: number, b: any) => n + b.licenses.length, 0);
    const fileBytes = Math.max(10 * 1048576, 1048576 + fonts * 65536 * 8), fileCount = fonts * 3 + licenses + 1;
    return { fileBytes, fileCount, bytes: fileBytes * fileCount };
}
/** One owned process group; only the parent publishes/account files, one 64KiB IPC write at a time. */
export async function renderTask(c: Context, row: any, template: any, snapshot: any, signal: AbortSignal): Promise<TaskRenderReceipt> {
    if (process.platform !== 'linux')
        throw taskError('TASK_RUNTIME_UNAVAILABLE');
    signal.throwIfAborted();
    const { pool, files, repo } = c, p = row.resource_policy, bound = fontWorkspaceBound(snapshot), workspace = await files.workspace(row.id);
    // The shared coordinator allows active groups to progress until its global
    // emergency action; two independent decode pause gates can deadlock together.
    const globalGuard=c.resources.holds('worker:'+row.id,'worker')&&p.memoryPauseBytes===taskPolicy.memoryPauseBytes&&p.memoryStopBytes===taskPolicy.memoryStopBytes;
    await clearWorkspace(workspace);
    const used = Number((await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1', [row.id])).rows[0].storage_used_bytes);
    await repo.reserve(row.id, used + bound.bytes + 64 * 1048576, row.lease_token);
    const raw = (await pool.query('SELECT id,checksum,storage_key,logical_path FROM task_files WHERE task_id=$1 AND state=\'received\' AND role=\'original_image\'', [row.id])).rows;
    const sources = await Promise.all(raw.map(async (f) => ({ ...f, path: await files.path(f.storage_key) })));
    const normalized = (await pool.query('SELECT storage_key FROM task_files WHERE id=$1 AND task_id=$2 AND state=\'received\'', [row.normalized_file_id, row.id])).rows[0];
    if (!normalized)
        throw taskError('INPUT_INTEGRITY');
    const env = { ...process.env, NODE_CHANNEL_FD: '3', NODE_CHANNEL_SERIALIZATION_MODE: 'advanced', TMPDIR: workspace, PYTHONDONTWRITEBYTECODE: '1' };
    const readGrant = await taskReadBudget.acquire(row.id,signal);
    let child:ReturnType<typeof spawn>;
    try {child = spawn(process.env.PYTHON_EXECUTABLE ?? 'python', [fileURLToPath(new URL('../../runtime/python/task_launcher.py', import.meta.url)), String(bound.fileBytes), process.execPath, fileURLToPath(new URL('./render-child.js', import.meta.url))], { env, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });}
    catch(e){readGrant.release();throw e;}
    let closed = false, failed: unknown, completion: TaskRenderReceipt | undefined, handling = false, chain = Promise.resolve(), workspaceBytes = 0, workspaceClosed = false, preparationFindings = 0, preparationOmitted = 0;
    const handles = new Map<string, {
        handle: FileHandle;
        kind: string;
        size: number;
        hash: ReturnType<typeof createHash>;
        fileId?: string;
    }>(), sealed = new Map<string, {
        key: string;
        byteLength: number;
        sha256: string;
    }>();
    const kill = () => {
        if (!closed && child.pid)
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch { }
    };
    const abort = () => {
        send({ type: 'abort', code: (signal.reason as any)?.code ?? 'WORKER_INTERRUPTED' });
    };
    function send(message:any){
        if(!child.connected)return;
        try{child.send(message,error=>{if(error){failed??=taskError('RENDER_FAILED');kill();}});}
        catch{failed??=taskError('RENDER_FAILED');kill();}
    }
    const stop = async () => {
        abort();
        if (!closed) {
            const timer = setTimeout(kill, p.stopMs);
            await closure;
            clearTimeout(timer);
        }
    };
    const closure = new Promise<void>(resolve => {
        child.once('error', () => { failed ??= taskError('RENDER_FAILED'); });
        child.once('close', (code) => {
            closed = true;
            if (code !== 0 && !completion && !failed)
                failed = taskError('RENDER_FAILED');
            resolve();
        });
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted)
        abort();
    const writeUsed = async (delta: number) => transaction(pool, async (client) => {
        await quotaLock(client);
        const current = await repo.row(client, row.id);
        repo.live(current);
        if (current.lease_token !== row.lease_token || current.stop_requested_at)
            throw taskError('WORKER_INTERRUPTED');
        await client.query('UPDATE task_resource_reservations SET storage_used_bytes=storage_used_bytes+$2,updated_at=now() WHERE task_id=$1', [row.id, delta]);
    });
    async function operation(m: any) {
        signal.throwIfAborted();
        if (!m || !Number.isSafeInteger(m.id) || typeof m.op !== 'string')
            throw taskError('INVALID_DATA');
        if(m.op==='reader-closed'){readGrant.release();return null;}
        if (m.op === 'decode') {
            while (!globalGuard&&await groupMemory(child.pid!) >= p.memoryPauseBytes) {
                signal.throwIfAborted();
                if (closed || failed)
                    throw failed ?? taskError('WORKER_INTERRUPTED');
                await new Promise(r => setTimeout(r, 50));
            }
            return null;
        }
        if (m.op === 'open') {
            if (!['prepared', 'output'].includes(m.kind) || m.kind === 'output' && !workspaceClosed || handles.size + sealed.size > 4001)
                throw taskError('LIMIT_EXCEEDED');
            const id = randomUUID(), key = row.id + '/' + m.kind + '/' + id + '.bin.part';
            const h = { handle: await files.open(key), kind: m.kind, size: 0, hash: createHash('sha256'), ...(m.kind === 'prepared' ? { fileId: id } : {}) };
            handles.set(key, h);
            if (h.fileId)
                await pool.query("INSERT INTO task_files(id,task_id,role,logical_path,part_order,media_type,storage_key,state) SELECT $1,$2,'prepared_image','',coalesce(max(part_order),0)+1,'application/octet-stream',$3,'receiving' FROM task_files WHERE task_id=$2", [id, row.id, key]);
            return { key };
        }
        if (m.op === 'write') {
            const h = handles.get(m.key);
            if (!h || !Buffer.isBuffer(m.chunk) || m.chunk.length > 65536 || h.size + m.chunk.length > (h.kind === 'output' ? p.pdfBytes : p.imageBytes))
                throw taskError('LIMIT_EXCEEDED');
            const q = (await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1', [row.id])).rows[0];
            await repo.reserve(row.id, Number(q.storage_used_bytes) + m.chunk.length + (workspaceClosed ? 0 : bound.bytes), row.lease_token);
            await h.handle.writeFile(m.chunk);
            h.size += m.chunk.length;
            h.hash.update(m.chunk);
            await writeUsed(m.chunk.length);
            if (h.fileId)
                await pool.query('UPDATE task_files SET stored_bytes=$2,received_bytes=$2 WHERE id=$1', [h.fileId, h.size]);
            return null;
        }
        if (m.op === 'seal') {
            const h = handles.get(m.key);
            if (!h || h.size < 1)
                throw taskError('INVALID_DATA');
            await h.handle.sync();
            await h.handle.close();
            handles.delete(m.key);
            const key = await files.publish(m.key), ref = { key, byteLength: h.size, sha256: h.hash.digest('hex') };
            sealed.set(key, ref);
            if (h.fileId)
                await pool.query("UPDATE task_files SET state='received',storage_key=$2,checksum=$3,published_at=clock_timestamp() WHERE id=$1", [h.fileId, key, ref.sha256]);
            return ref;
        }
        if (m.op === 'path') {
            if (!sealed.has(m.key))
                throw taskError('INPUT_INTEGRITY');
            return files.path(m.key);
        }
        if (m.op === 'workspaceSealed') {
            if (workspaceClosed)
                throw taskError('INVALID_DATA');
            workspaceBytes = await workspaceSize(workspace);
            if (workspaceBytes > bound.bytes)
                throw taskError('STORAGE_IO');
            await writeUsed(workspaceBytes);
            workspaceClosed = true;
            return null;
        }
        if (m.op === 'finding') {
            if (m.code !== 'IMAGE_UNUSABLE' || !(m.sectionId === null || typeof m.sectionId === 'string' && Buffer.byteLength(m.sectionId) <= 256) || typeof m.pointer !== 'string' || !m.pointer.startsWith('/') || Buffer.byteLength(m.pointer) > 2048 || !Number.isSafeInteger(m.affectedPlacementCount) || m.affectedPlacementCount < 1 || preparationOmitted + m.affectedPlacementCount > 10000 || !m.detail || m.detail.stage !== 'preparation' || Buffer.byteLength(JSON.stringify(m.detail)) > 32768)
                throw taskError('INVALID_DATA');
            await transaction(pool, async (client) => { const r = await repo.row(client, row.id); repo.live(r); await client.query("INSERT INTO task_findings(id,task_id,sequence,code,section_id,pointer,affected_placement_count,detail) SELECT $1,$2,coalesce(max(sequence),0)+1,$3,$4,$5,$6,$7 FROM task_findings WHERE task_id=$2 HAVING count(*)<$8", [randomUUID(), row.id, m.code, m.sectionId, m.pointer, m.affectedPlacementCount, JSON.stringify(m.detail),p.findingDetails]); });
            preparationFindings++;
            preparationOmitted += m.affectedPlacementCount;
            return null;
        }
        if (m.op === 'failed')
            throw taskError(typeof m.code === 'string' && /^[A-Z_]+$/.test(m.code) ? m.code : 'RENDER_FAILED');
        if (m.op === 'complete') {
            if (completion || handles.size || JSON.stringify(m).length > 131072 || !Array.isArray(m.warnings) || m.warnings.length > 100)
                throw taskError('INVALID_DATA');
            const ref = sealed.get(m.output.replace(/\.part$/, ''));
            if (!ref || ref.sha256 !== m.receipt?.sha256 || ref.byteLength !== m.receipt?.byteLength || !Number.isSafeInteger(m.receipt.pageCount) || m.receipt.pageCount < 1 || m.receipt.pageCount > 2000)
                throw taskError('STORAGE_IO');
            const summary = m.summary;
            if (!summary || summary.version !== 1 || summary.scope !== 'expanded-image-nodes' || !['complete', 'partial'].includes(summary.completeness) || ['imagePlacementCount', 'normalizedOmittedPlacementCount', 'preparationOmittedPlacementCount', 'omittedPlacementCount', 'findingCount', 'formatOmissionCount'].some(k => !Number.isSafeInteger(summary[k]) || summary[k] < 0 || summary[k] > 10000) || summary.findingCount !== preparationFindings || summary.preparationOmittedPlacementCount !== preparationOmitted || summary.omittedPlacementCount !== summary.normalizedOmittedPlacementCount + preparationOmitted || summary.omittedPlacementCount > summary.imagePlacementCount || summary.omittedPlacementCount && summary.completeness !== 'partial' || Buffer.byteLength(JSON.stringify(summary)) > 8192)
                throw taskError('INVALID_DATA');
            completion = { summary, output: ref.key, receipt: { byteLength: ref.byteLength, sha256: ref.sha256, pageCount: m.receipt.pageCount }, warnings: m.warnings, warningCount: m.warningCount };
            return null;
        }
        throw taskError('INVALID_DATA');
    }
    child.on('message', (m: any) => {
        if (handling) {
            failed = taskError('LIMIT_EXCEEDED');
            kill();
            return;
        }
        handling = true;
        chain = chain.then(async () => {
            try {
                const value = await operation(m);
                send({ ack: m.id, value });
            }
            catch (e) {
                failed = e;
                send({ ack: m.id, error: (e as any)?.code ?? 'STORAGE_IO' });
                kill();
            }
            finally {
                handling = false;
            }
        });
    });
    let checking = false;
    const memory = setInterval(() => {
        if (checking || closed || globalGuard)
            return;
        checking = true;
        void groupMemory(child.pid!).then(n => {
            if (n >= p.memoryStopBytes) {
                failed = taskError('MEMORY_LIMIT');
                kill();
            }
        }).catch(() => { failed = taskError('WORKER_INTERRUPTED'); kill(); }).finally(() => { checking = false; });
    }, 100);
    try {
        if (!child.pid)
            throw taskError('TASK_RUNTIME_UNAVAILABLE');
        await pool.query('UPDATE tasks SET child_pid=$2,child_host=$3 WHERE id=$1', [row.id, child.pid, hostname()]);
        send({ type: 'init', input: { taskId:row.id,readCacheBytes:readGrant.cacheBytes,fieldIndexBytes:readGrant.indexBytes,recordReuseBytes:readGrant.recordBytes,path: await files.path(normalized.storage_key), digest: row.normalized_digest, template, templateFingerprint: row.template_pin.fingerprint, core: { version: row.normalization_summary.coreVersion, sha256: row.normalization_summary.coreSha256 }, fontSnapshot: snapshot, fontRoot: process.env.FONT_STORAGE_DIR ?? 'staging/fonts', workspace, sources, policy: p } });
        const cancelled = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        await Promise.race([closure, cancelled]);
        if (signal.aborted)
            await stop();
        await closure;
        await chain;
        signal.throwIfAborted();
        if (failed)
            throw failed;
        if (!completion)
            throw taskError('RENDER_FAILED');
        await transaction(pool, async (client) => { await quotaLock(client); const r = await repo.row(client, row.id); repo.live(r); if (r.lease_token !== row.lease_token || r.lease_due || r.stop_requested_at || r.generation_summary)
            throw taskError('WORKER_INTERRUPTED'); await client.query('UPDATE tasks SET generation_summary=$2,updated_at=now() WHERE id=$1', [row.id, JSON.stringify(completion!.summary)]); });
        return completion;
    }
    finally {
        clearInterval(memory);
        signal.removeEventListener('abort', abort);
        if (!closed)
            await stop();
        await chain;
        for (const h of handles.values())
            try {
                await h.handle.close();
            }
            catch { }
        // Group close is required before releasing its scratch promise, including failed Python descendants.
        if (child.pid && !await groupStopped(child.pid, hostname(), hostname())) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            }
            catch { }
            const end = Date.now() + p.stopMs;
            while (!await groupStopped(child.pid, hostname(), hostname())) {
                if (Date.now() >= end)
                    throw taskError('WORKER_STOP_UNCONFIRMED');
                await new Promise(r => setTimeout(r, 20));
            }
        }
        readGrant.release();
        await clearWorkspace(workspace);
        if (workspaceBytes)
            await pool.query('UPDATE task_resource_reservations SET storage_used_bytes=storage_used_bytes-$2 WHERE task_id=$1', [row.id, workspaceBytes]);
        await pool.query('UPDATE tasks SET child_pid=NULL,child_host=NULL WHERE id=$1', [row.id]);
    }
}
async function groupMemory(child: number) {
    let total = process.memoryUsage().rss;
    for (const id of await readdir('/proc')) {
        if (!/^\d+$/.test(id))
            continue;
        try {
            const stat = await readFile('/proc/' + id + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            if (Number(fields[2]) !== child)
                continue;
            const status = await readFile('/proc/' + id + '/status', 'utf8');
            total += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
        }
        catch (e) {
            if ((e as any)?.code !== 'ENOENT' && (e as any)?.code !== 'ESRCH')
                throw e;
        }
    }
    return total;
}
