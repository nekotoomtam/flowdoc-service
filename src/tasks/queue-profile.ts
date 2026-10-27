import {MAX_QUEUE_RESERVATIONS,processingCreditCeiling} from './queue-limits.js';
const MiB=1048576;
export interface QueueProfile {
 readonly name:'1g-2cpu'|'6g-2cpu';readonly policyVersion:string;readonly memoryBytes:number;readonly cpuCount:2;
 readonly adaptiveProcessing:boolean;readonly maxProcessing:number;readonly idleMs:number;readonly processMs:number;readonly maxOutstanding:number;readonly admissionMiB:number;readonly pressureMiB:number;readonly resumeMiB:number;readonly emergencyMiB:number;readonly strict:boolean;
}
export const DEFAULT_QUEUE_PROFILE:QueueProfile=Object.freeze({name:'1g-2cpu',policyVersion:'task-v1-queue-2worker-trial-1',memoryBytes:1024*MiB,cpuCount:2,maxOutstanding:10,admissionMiB:768,pressureMiB:832,resumeMiB:704,emergencyMiB:896,strict:false,adaptiveProcessing:false,maxProcessing:2,idleMs:60000,processMs:5400000});
export const SIX_GIB_QUEUE_PROFILE:QueueProfile=Object.freeze({name:'6g-2cpu',policyVersion:'task-v1-queue-6g-2cpu-trial-3',memoryBytes:6144*MiB,cpuCount:2,maxOutstanding:20,admissionMiB:4608,pressureMiB:4992,resumeMiB:4224,emergencyMiB:5376,strict:true,adaptiveProcessing:true,maxProcessing:3,idleMs:180000,processMs:300000});
export function readTaskQueueConfig(env:NodeJS.ProcessEnv):{profile:QueueProfile;maxOutstanding:number}{
 const name=env.TASK_QUEUE_PROFILE??'1g-2cpu';
 if(name!=='1g-2cpu'&&name!=='6g-2cpu')throw Error('Invalid TASK_QUEUE_PROFILE');
 const processMs=env.TASK_QUEUE_PROCESS_TIMEOUT_MS;
 if(processMs!==undefined&&(name!=='6g-2cpu'||!['300000','600000'].includes(processMs)))throw Error('Invalid TASK_QUEUE_PROCESS_TIMEOUT_MS');
 const selected=name==='6g-2cpu'?SIX_GIB_QUEUE_PROFILE:DEFAULT_QUEUE_PROFILE,raw=env.TASK_QUEUE_MAX_OUTSTANDING??String(selected.maxOutstanding),workers=env.TASK_QUEUE_MAX_PROCESSING??String(selected.maxProcessing);
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>(selected.strict?MAX_QUEUE_RESERVATIONS:selected.maxOutstanding))throw Error('Invalid TASK_QUEUE_MAX_OUTSTANDING');
 if(env.TASK_QUEUE_MAX_PROCESSING!==undefined&&!selected.strict)throw Error('Processing selection requires explicit6GiB profile');
 if(!/^[1-9]\d*$/.test(workers)||!Number.isSafeInteger(Number(workers))||Number(workers)>(selected.strict?processingCreditCeiling(selected.admissionMiB):2))throw Error('Invalid TASK_QUEUE_MAX_PROCESSING');
 const profile=selected.strict?Object.freeze({...selected,maxOutstanding:Number(raw),maxProcessing:Number(workers),processMs:processMs===undefined?selected.processMs:Number(processMs)}):selected;
 if(profile.strict&&env.JOB_MAX_OUTSTANDING!==undefined&&env.JOB_MAX_OUTSTANDING!==raw)throw Error('Conflicting task and legacy queue ceilings');
 return{profile,maxOutstanding:Number(raw)};
}
export function queueAdmissionLimit(legacyLimit:number,config:{profile:QueueProfile;maxOutstanding:number}):number{return config.profile.strict?config.maxOutstanding:legacyLimit;}
export function parseQueueCpuLimit(text:string):number|null{
 const fields=text.trim().split(/\s+/);if(fields.length!==2||fields[0]==='max')return null;
 const quota=Number(fields[0]),period=Number(fields[1]);
 return Number.isSafeInteger(quota)&&quota>0&&Number.isSafeInteger(period)&&period>0?quota/period:null;
}
export function isSixGiBQueuePolicyVersion(version:string):boolean{return version==='task-v1-queue-6g-2cpu-trial-1'||version==='task-v1-queue-6g-2cpu-trial-2'||version===SIX_GIB_QUEUE_PROFILE.policyVersion;}
export function isQueuePolicyVersion(version:string):boolean{return version===DEFAULT_QUEUE_PROFILE.policyVersion||isSixGiBQueuePolicyVersion(version);}

export function usesInputWaitBudget(version:string):boolean{return version==='task-v1-queue-6g-2cpu-trial-2'||version===SIX_GIB_QUEUE_PROFILE.policyVersion;}
