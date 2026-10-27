/** Shared existing reservation arithmetic; no storage/credit expansion. */
export const TASK_POOL_BYTES=1_500_000_000,TASK_INITIAL_BYTES=8*1048576;
export const MAX_QUEUE_RESERVATIONS=Math.floor(TASK_POOL_BYTES/TASK_INITIAL_BYTES);
export const QUEUE_BASE_MIB=128,QUEUE_CREDITS=Object.freeze({intake:64,worker:320,sender:8});
export const processingCreditCeiling=(admissionMiB:number)=>Math.max(1,Math.floor((admissionMiB-QUEUE_BASE_MIB-2*QUEUE_CREDITS.intake-2*QUEUE_CREDITS.sender)/QUEUE_CREDITS.worker));
