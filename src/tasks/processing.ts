import type { Pool, PoolClient } from 'pg';
import {taskWire,type TaskWire} from './wire.js';
import {taskSnapshot,publicCode,stageFor} from './public.js';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { transaction } from '../db/connection.js';
import type { createTaskIntake } from './intake.js';
import { quotaLock, taskError } from './quota.js';
import { processIdentity } from './workspace.js';
import { terminal, safeTask, taskCompleteness } from './repository.js';
import { readReferences, verifyReferences } from '../fonts/retention.js';
import { resolveFontReadiness } from '../fonts/readiness.js';
import { makeFontSnapshot, persistJobFonts, validateFontSnapshot, rendererIdentity } from '../fonts/snapshot.js';
import { renderTask, fontWorkspaceBound, type TaskRenderReceipt } from './render.js';
export interface TaskResponse {
    start(contentType: string): void;
    write(chunk: Uint8Array): Promise<void>;
    /** Resolve only on transport finish. abort settles outstanding writes. */
    end(): Promise<void>;
    abort(): Promise<void>;
}
interface Dependencies {
    pool: Pool;
    intake: Awaited<ReturnType<typeof createTaskIntake>>;
    workerReady: () => boolean;
    render?: typeof renderTask;
}
type Execution = {
    abort: AbortController;
    done: Promise<void>;
    renderDone?: Promise<void>;
    receipt?: TaskRenderReceipt;
};
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const reason = (e: any) => typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'RENDER_FAILED';
export async function createTaskProcessing(deps: Dependencies) {
    const { pool, intake } = deps, { repo, files, owned, active, cleanup } = intake.processingContext;
    const executing = new Map<string, Execution>();
    let closing = false;
    async function admit(header: string, id: string) {
        const { r } = await owned(header, id, true);
        if (terminal(r.status))
            throw taskError('TASK_REQUEST_CONFLICT');
        if (!deps.workerReady() || closing)
            throw taskError('UNAVAILABLE');
        return transaction(pool, async (c) => {
            await quotaLock(c);
            const row = await repo.row(c, id);
            repo.live(row);
            if (row.status !== 'validating' || !row.normalized_at || row.lease_token)
                throw taskError('TASK_REQUEST_CONFLICT');
            if (row.normalization_summary.coreVersion !== rendererIdentity.version || row.normalization_summary.coreSha256 !== rendererIdentity.sha256)
                throw taskError('RENDERER_PIN_MISMATCH');
            const v = (await c.query('SELECT definition_json,fingerprint FROM template_versions WHERE id=$1', [row.template_version_id])).rows[0];
            if (!v || v.fingerprint !== row.template_pin.fingerprint)
                throw taskError('INVALID_DATA');
            const refs = await readReferences(c, v.definition_json.templateId, 0, row.template_version_id);
            verifyReferences(v.definition_json, v.fingerprint, refs);
            const ids = [...new Set(Object.values(v.definition_json.styles).flatMap((s: any) => s.font?.kind === 'library' ? [s.font.releaseId] : []))].sort();
            if (ids.length)
                await c.query('SELECT id FROM font_releases WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
            const fonts = await resolveFontReadiness(c, v.definition_json, v.fingerprint, refs, undefined, undefined, { deferFiles: true });
            if (!fonts.snapshot)
                throw taskError(fonts.readiness.issues[0]?.code ?? 'FONT_CHECK_UNAVAILABLE');
            const snapshot = makeFontSnapshot(v.fingerprint, row.normalized_digest, fonts.snapshot.bindings, fonts.snapshot.legacy), core = { version: rendererIdentity.version, sha256: rendererIdentity.sha256 }, job = randomUUID();
            await c.query('INSERT INTO generation_jobs(id,task_id,template_version_id,original_input,prepared_input) VALUES($1,$2,$3,$4,$5)', [job, id, row.template_version_id, JSON.stringify({ contract: 'flowdoc-task-request/1', taskId: id, inputDigest: row.input_digest }), JSON.stringify({ contract: 'flowdoc-task-job/1', taskId: id, normalizedFileId: row.normalized_file_id, normalizedDigest: row.normalized_digest, core })]);
            await persistJobFonts(c, job, snapshot);
            const n = (await c.query("UPDATE tasks SET status='queued',lease_token=$2,lease_expires_at=LEAST(expires_at,clock_timestamp()+((resource_policy->>'leaseMs')::int*interval '1 millisecond')),writer_pid=$3,writer_host=$4,writer_start_identity=$5,state_version=state_version+1,updated_at=now() WHERE id=$1 RETURNING *", [id, randomUUID(), process.pid, hostname(), await processIdentity(process.pid)])).rows[0];
            await repo.event(c, n, 'queued', row.status);
            return { row: n, snapshot };
        });
    }
    async function execute(request: {
        authorization: string;
        taskId: string;
        response: TaskResponse;
        signal?: AbortSignal;
        wire?: TaskWire;
    }) {
        const admission = await admit(request.authorization, request.taskId), id = request.taskId, row = admission.row, p = row.resource_policy;
        const abort = new AbortController();
        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => { resolveDone = resolve; });
        const execution: Execution = { abort, done };
        executing.set(id, execution);
        active.set(id, { abort, done });
        let generation = 'not_started', delivery = 'not_started', pdf: TaskRenderReceipt | undefined, renewing = false;
        const disconnect = () => abort.abort(taskError('CONNECTION_LOST'));
        request.signal?.addEventListener('abort', disconnect, { once: true });
        if (request.signal?.aborted)
            disconnect();
        const poll = setInterval(() => {
            if (renewing)
                return;
            renewing = true;
            void (async () => {
                const r = await repo.get(id);
                if (r.status === 'queued' && !deps.workerReady())
                    abort.abort(taskError('WORKER_INTERRUPTED'));
                else if (r.due)
                    abort.abort(taskError('TASK_EXPIRED'));
                else if (!await repo.renew(id, row.lease_token))
                    abort.abort(taskError('WORKER_INTERRUPTED'));
            })().catch(() => abort.abort(taskError('WORKER_INTERRUPTED'))).finally(() => { renewing = false; });
        }, Math.min(1000, Math.floor(p.leaseMs / 3)));

        let started = false, lastState = '', lastFeedback = 0;
        async function transport(operation: () => Promise<void>) {
            abort.signal.throwIfAborted();
            let timer: NodeJS.Timeout | undefined, onAbort!: () => void;
            const stop = new Promise<never>((_, reject) => { onAbort = () => reject(abort.signal.reason); abort.signal.addEventListener('abort', onAbort, { once: true }); timer = setTimeout(() => abort.abort(taskError('CONNECTION_TIMEOUT')), p.writeMs); });
            const pending = operation();
            try {
                await Promise.race([pending, stop]);
                abort.signal.throwIfAborted();
            }
            catch (e) {
                await request.response.abort();
                await pending.catch(() => { });
                throw e;
            }
            finally {
                clearTimeout(timer);
                abort.signal.removeEventListener('abort', onAbort);
            }
        }
        const wire=request.wire??taskWire({start:t=>request.response.start(t),write:b=>transport(()=>request.response.write(b)),end:()=>transport(()=>request.response.end()),abort:()=>request.response.abort()},id);
        async function feedback(r:any){
            if(r.status===lastState&&Date.now()-lastFeedback<1000)return;
            lastState=r.status;lastFeedback=Date.now();
            if(!wire.started)await wire.event('task',r.status,{createdAt:r.created_at.toISOString(),expiresAt:r.expires_at.toISOString(),template:r.template_pin});
            await wire.event('progress',r.status,{stage:stageFor(r),completed:null,total:null,unit:null});
        }
        try {
            const q = (await pool.query('SELECT storage_used_bytes FROM task_resource_reservations WHERE task_id=$1', [id])).rows[0];
            await repo.reserve(id, Number(q.storage_used_bytes) + fontWorkspaceBound(admission.snapshot).bytes + 64 * 1048576, row.lease_token);
            started = true;
            while (true) {
                abort.signal.throwIfAborted();
                const r = (await pool.query('SELECT t.*,j.id AS job_id,j.status AS job_status FROM tasks t LEFT JOIN generation_jobs j ON j.task_id=t.id WHERE t.id=$1', [id])).rows[0];
                if (r.processing_started_at)
                    generation = 'interrupted';
                if (terminal(r.status))
                    throw taskError(r.terminal_reason ?? 'RENDER_FAILED');
                await feedback(r);
                if (r.status === 'sending')
                    break;
                await wait(20);
            }
            await execution.renderDone;
            abort.signal.throwIfAborted();
            pdf = execution.receipt;
            if (!pdf)
                throw taskError('RENDER_FAILED');
            generation = 'succeeded';
            const output = (await pool.query('SELECT o.* FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE j.task_id=$1 AND o.deleted_at IS NULL', [id])).rows[0];
            if (!output || output.sha256 !== pdf.receipt.sha256 || Number(output.byte_size) !== pdf.receipt.byteLength)
                throw taskError('STORAGE_IO');
            const snapshot=await taskSnapshot(pool,intake,request.authorization,id,undefined,10);
            if(snapshot.task.counts.findingCount||pdf.warningCount){const detail={findings:[...snapshot.findings],...snapshot.task.counts,detailsTruncated:snapshot.task.detailsTruncated||snapshot.nextCursor!==null};while(Buffer.byteLength(JSON.stringify(detail))>30000&&detail.findings.length){detail.findings.pop();detail.detailsTruncated=true;}await wire.event('warning','sending',detail);}
            delivery = 'interrupted';
            await wire.pdf(await files.path(pdf.output),{bytes:Number(output.byte_size),sha256:output.sha256,pageCount:pdf.receipt.pageCount,completeness:snapshot.task.completeness,...snapshot.task.counts},abort.signal);
            const n = await transaction(pool, async (c) => {
                await quotaLock(c);
                const r = await repo.row(c, id);
                repo.live(r);
                if (r.status !== 'sending' || r.stop_requested_at || r.lease_token !== row.lease_token || r.lease_due)
                    throw taskError('WORKER_INTERRUPTED');
                if ((await c.query("SELECT clock_timestamp()>=send_started_at+((resource_policy->>'sendMs')::int*interval '1 millisecond') AS late FROM tasks WHERE id=$1", [id])).rows[0].late)
                    throw taskError('TASK_TIMEOUT');
                const next = (await c.query("UPDATE tasks SET status='succeeded',terminal_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,writer_pid=NULL,writer_host=NULL,cleanup_status='pending',state_version=state_version+1,updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
                await c.query('UPDATE task_resource_reservations SET queue_slot_held=false WHERE task_id=$1', [id]);
                await c.query('INSERT INTO task_usage(task_id,revision,facts) VALUES($1,1,$2)', [id, JSON.stringify(facts(next, 'succeeded', 'succeeded', pdf))]);
                await repo.event(c, next, 'terminal', r.status);
                return next;
            });
            delivery = 'succeeded';
            return safeTask(n);
        }
        catch (e) {
            const cause=abort.signal.aborted?abort.signal.reason:e;
            abort.abort(cause);
            await pool.query('UPDATE tasks SET stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) WHERE id=$1 AND terminal_at IS NULL', [id]);
            await execution.renderDone;
            pdf = execution.receipt ?? pdf;
            if (pdf)
                generation = 'succeeded';
            await repo.finish(id, reason(cause), undefined, facts(await repo.get(id), generation, delivery, pdf));
            if (started) {
                if(!abort.signal.aborted||!request.signal?.aborted)await wire.error(publicCode(reason(cause)),generation==='succeeded'?'sending':'composing',(await repo.get(id)).status).catch(()=>request.response.abort());
                else await request.response.abort();
            }
            throw taskError((await repo.get(id)).terminal_reason ?? reason(cause));
        }
        finally {
            clearInterval(poll);
            request.signal?.removeEventListener('abort', disconnect);
            await pool.query("UPDATE tasks SET writer_pid=NULL,writer_host=NULL,writer_start_identity=NULL,lease_expires_at=clock_timestamp() WHERE id=$1 AND terminal_at IS NULL AND stop_requested_at IS NOT NULL", [id]);
            executing.delete(id);
            active.delete(id);
            try {
                await cleanup(id);
            }
            finally {
                resolveDone();
            }
        }
    }
    async function runNext(signal: AbortSignal, leader: PoolClient) {
        if (closing)
            return false;
        const held = (await leader.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objid=60430404 AND granted")).rowCount;
        if (!held)
            throw taskError('WORKER_INTERRUPTED');
        const job = (await pool.query("SELECT id,task_id FROM generation_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1")).rows[0];
        if (!job?.task_id)
            return false;
        const execution = executing.get(job.task_id);
        if (!execution)
            return false;
        if (execution.abort.signal.aborted)
            return false;
        const abort = execution.abort, onStop = () => abort.abort(taskError('WORKER_INTERRUPTED'));
        signal.addEventListener('abort', onStop, { once: true });
        if (signal.aborted)
            onStop();
        const pending = (async () => {
            let timer: NodeJS.Timeout | undefined;
            try {
                const row = await transaction(pool, async (c) => {
                    await quotaLock(c);
                    const r = await repo.row(c, job.task_id);
                    repo.live(r);
                    if (r.status !== 'queued' || r.stop_requested_at)
                        throw taskError('WORKER_INTERRUPTED');
                    await c.query("UPDATE generation_jobs SET status='running',started_at=clock_timestamp() WHERE id=$1 AND status='queued'", [job.id]);
                    const n = (await c.query("UPDATE tasks SET status='processing',processing_started_at=clock_timestamp(),state_version=state_version+1,updated_at=now() WHERE id=$1 RETURNING *,extract(epoch FROM (expires_at-clock_timestamp()))*1000 AS remaining", [r.id])).rows[0];
                    await repo.event(c, n, 'processing', r.status);
                    return n;
                });
                timer = setTimeout(() => abort.abort(taskError(Number(row.remaining) <= row.resource_policy.processMs ? 'TASK_EXPIRED' : 'TASK_TIMEOUT')), Math.max(1, Math.min(Number(row.remaining), row.resource_policy.processMs)));
                const v = (await pool.query('SELECT definition_json FROM template_versions WHERE id=$1', [row.template_version_id])).rows[0], snapshot = (await pool.query('SELECT snapshot FROM job_font_snapshots WHERE job_id=$1', [job.id])).rows[0]?.snapshot;
                validateFontSnapshot(snapshot, row.template_pin.fingerprint, row.normalized_digest);
                abort.signal.throwIfAborted();
                const receipt = await (deps.render ?? renderTask)(intake.processingContext, row, v.definition_json, snapshot, abort.signal);
                abort.signal.throwIfAborted();
                execution.receipt = receipt;
                let n: any;
                while (!n) {
                    abort.signal.throwIfAborted();
                    n = await transaction(pool, async (c) => {
                        await quotaLock(c);
                        const r = await repo.row(c, row.id);
                        repo.live(r);
                        if (r.status !== 'processing' || r.stop_requested_at || r.lease_due)
                            throw taskError('WORKER_INTERRUPTED');
                        const sending = Number((await c.query("SELECT count(*) FROM tasks WHERE status='sending'")).rows[0].count);
                        if (sending >= r.resource_policy.maxSenders)
                            return null;
                        await c.query("UPDATE generation_jobs SET status='succeeded',finished_at=clock_timestamp(),task_warning_count=$2 WHERE id=$1", [job.id, receipt.warningCount]);
                        await c.query("INSERT INTO job_processing(job_id,stage,completed,total,warnings_json) VALUES($1,'complete',1,1,$2)", [job.id, JSON.stringify(receipt.warnings)]);
                        await c.query("INSERT INTO document_outputs(id,job_id,path,media_type,byte_size,retain,expires_at,sha256,page_count) VALUES(uuidv7(),$1,$2,'application/pdf',$3,false,$4,$5,$6)", [job.id, await files.path(receipt.output), receipt.receipt.byteLength, r.expires_at, receipt.receipt.sha256, receipt.receipt.pageCount]);
                        const next = (await c.query("UPDATE tasks SET status='sending',send_started_at=clock_timestamp(),state_version=state_version+1,updated_at=now() WHERE id=$1 RETURNING *,extract(epoch FROM(expires_at-clock_timestamp()))*1000 AS remaining", [r.id])).rows[0];
                        await repo.event(c, next, 'sending', r.status);
                        return next;
                    });
                    if (!n)
                        await wait(20);
                }
                clearTimeout(timer);
                timer = undefined;
                const sendTimer = setTimeout(() => abort.abort(taskError(Number(n.remaining) <= n.resource_policy.sendMs ? 'TASK_EXPIRED' : 'TASK_TIMEOUT')), Math.max(1, Math.min(Number(n.remaining), n.resource_policy.sendMs)));
                void execution.done.finally(() => clearTimeout(sendTimer));
            }
            catch (e) {
                abort.abort(e);
            }
            finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', onStop);
            }
        })();
        execution.renderDone = pending;
        await pending;
        return true;
    }
    return { execute, runNext, async stop() {
            closing = true;
            for (const e of executing.values())
                e.abort.abort(taskError('WORKER_INTERRUPTED'));
            await Promise.all([...executing.values()].map(e => e.done));
        } };
}
function facts(r: any, generation: string, delivery: string, pdf?: TaskRenderReceipt) { return { ownerKey: r.owner_key, principalId: r.created_by_principal, clientActorRef: r.client_actor_ref, billingSubjectKey: r.billing_subject_key, requestKind: r.request_kind, createdAt: r.created_at, expiresAt: r.expires_at, template: r.template_pin, policyVersion: r.resource_policy.version, status: r.status, reason: r.terminal_reason, core: { version: r.normalization_summary?.coreVersion ?? null, sha256: r.normalization_summary?.coreSha256 ?? null }, normalization: r.normalization_summary, processingStartedAt: r.processing_started_at, sendStartedAt: r.send_started_at, terminalAt: r.terminal_at, requestBytes: r.request_bytes === null ? null : Number(r.request_bytes), requestBytesMeasurement: r.request_bytes === null ? 'unknown_after_interruption' : 'observed', generation, delivery, pdfBytes: pdf?.receipt.byteLength ?? null, pageCount: pdf?.receipt.pageCount ?? null, pdfSha256: pdf?.receipt.sha256 ?? null, generationWarningCount: pdf?.warningCount ?? null, generationSummary: pdf?.summary ?? r.generation_summary ?? null, completeness: taskCompleteness(r, pdf?.summary ?? r.generation_summary) }; }
