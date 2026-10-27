const MiB=1048576;
export interface QueueProfile {
 readonly name:'1g-2cpu'|'6g-2cpu';readonly policyVersion:string;readonly memoryBytes:number;readonly cpuCount:2;
 readonly maxOutstanding:number;readonly admissionMiB:number;readonly pressureMiB:number;readonly resumeMiB:number;readonly emergencyMiB:number;readonly strict:boolean;
}
export const DEFAULT_QUEUE_PROFILE:QueueProfile=Object.freeze({name:'1g-2cpu',policyVersion:'task-v1-queue-2worker-trial-1',memoryBytes:1024*MiB,cpuCount:2,maxOutstanding:10,admissionMiB:768,pressureMiB:832,resumeMiB:704,emergencyMiB:896,strict:false});
export const SIX_GIB_QUEUE_PROFILE:QueueProfile=Object.freeze({name:'6g-2cpu',policyVersion:'task-v1-queue-6g-2cpu-trial-1',memoryBytes:6144*MiB,cpuCount:2,maxOutstanding:20,admissionMiB:4608,pressureMiB:4992,resumeMiB:4224,emergencyMiB:5376,strict:true});
export function readTaskQueueConfig(env:NodeJS.ProcessEnv):{profile:QueueProfile;maxOutstanding:number}{
 const name=env.TASK_QUEUE_PROFILE??'1g-2cpu';
 if(name!=='1g-2cpu'&&name!=='6g-2cpu')throw Error('Invalid TASK_QUEUE_PROFILE');
 const profile=name==='6g-2cpu'?SIX_GIB_QUEUE_PROFILE:DEFAULT_QUEUE_PROFILE,raw=env.TASK_QUEUE_MAX_OUTSTANDING??'10';
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>profile.maxOutstanding)throw Error('Invalid TASK_QUEUE_MAX_OUTSTANDING');
 if(profile.strict&&raw!=='10'&&raw!=='20')throw Error('Unsupported experimental queue size');
 if(profile.strict&&env.JOB_MAX_OUTSTANDING!==undefined&&env.JOB_MAX_OUTSTANDING!==raw)throw Error('Conflicting task and legacy queue ceilings');
 return{profile,maxOutstanding:Number(raw)};
}
export function queueAdmissionLimit(legacyLimit:number,config:{profile:QueueProfile;maxOutstanding:number}):number{return config.profile.strict?config.maxOutstanding:legacyLimit;}
export function parseQueueCpuLimit(text:string):number|null{
 const fields=text.trim().split(/\s+/);if(fields.length!==2||fields[0]==='max')return null;
 const quota=Number(fields[0]),period=Number(fields[1]);
 return Number.isSafeInteger(quota)&&quota>0&&Number.isSafeInteger(period)&&period>0?quota/period:null;
}
export function isQueuePolicyVersion(version:string):boolean{return version===DEFAULT_QUEUE_PROFILE.policyVersion||version===SIX_GIB_QUEUE_PROFILE.policyVersion;}
