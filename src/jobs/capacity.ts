import type {PoolClient} from 'pg';
import {OperationError} from '../errors.js';
import {validateMaxOutstanding} from './config.js';

/** Call inside the insertion transaction, after any upload-session lock.
 * This admission lock is distinct from the lifetime processor lock60430404.
 * All new-job paths hold it until COMMIT; replaying an existing job needs no slot.
 */
export async function reserveJobCapacity(client:PoolClient,maxOutstanding:number):Promise<void> {
 validateMaxOutstanding(maxOutstanding);
 await client.query('SELECT pg_advisory_xact_lock(60430405)');
 const result=await client.query<{count:string}>("SELECT count(*) FROM generation_jobs WHERE status IN ('queued','running')");
 if(Number(result.rows[0]!.count)>=maxOutstanding)
  throw new OperationError('QUEUE_FULL','job','Job queue is full; no new job was accepted. Try again later');
}
