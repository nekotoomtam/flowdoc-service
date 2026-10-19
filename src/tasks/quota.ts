import type {PoolClient} from 'pg';import {OperationError} from '../errors.js';
export const taskError=(code:string,message='Task operation could not complete')=>new OperationError(code,'task',message);
export async function quotaLock(c:PoolClient){await c.query("SET LOCAL lock_timeout='5s'");await c.query('SELECT pg_advisory_xact_lock(60430405)');}
export async function storageTotals(c:PoolClient){
 const r=(await c.query(`SELECT
 (SELECT coalesce(sum(storage_held_bytes),0) FROM task_resource_reservations) AS held,
 (SELECT coalesce(sum(storage_used_bytes),0) FROM task_resource_reservations) AS used,
 (SELECT min((resource_policy->>'poolBytes')::bigint) FROM tasks t JOIN task_resource_reservations r ON r.task_id=t.id WHERE r.storage_held_bytes>0) AS pool,
 (SELECT max((resource_policy->>'freeFloorBytes')::bigint) FROM tasks t JOIN task_resource_reservations r ON r.task_id=t.id WHERE r.storage_held_bytes>0) AS floor,
 (SELECT coalesce(sum(reserved_bytes),0) FROM upload_sessions WHERE deleted_at IS NULL) AS legacy,
 (SELECT coalesce(sum(o.byte_size),0) FROM document_outputs o JOIN generation_jobs j ON j.id=o.job_id WHERE o.deleted_at IS NULL AND j.task_id IS NULL) AS outputs,
 (SELECT coalesce(sum(received_bytes),0) FROM upload_items WHERE source_kind='upload' AND upload_id IN (SELECT id FROM upload_sessions WHERE deleted_at IS NULL)) AS legacy_used`)).rows[0];
 return {held:Number(r.held),used:Number(r.used),pool:r.pool===null?null:Number(r.pool),floor:Number(r.floor??0),legacy:Number(r.legacy)+Number(r.outputs),legacyUnused:Math.max(0,Number(r.legacy)-Number(r.legacy_used))};
}
/** Existing upload/image reservations use this while holding the shared admission lock. */
export async function assertTaskPoolCapacity(c:PoolClient,additional:number,freeBytes?:()=>Promise<number>){
 const t=await storageTotals(c);if(t.pool===null)return;const free=freeBytes?await freeBytes():-1;
 if(!Number.isSafeInteger(free)||free<0||t.held+t.legacy+additional>t.pool||t.held-t.used+t.legacyUnused+additional>free-t.floor)throw taskError('STORAGE_CAPACITY','Temporary storage capacity unavailable');
}
