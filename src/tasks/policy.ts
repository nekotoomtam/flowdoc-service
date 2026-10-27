import {TASK_POOL_BYTES,TASK_INITIAL_BYTES,processingCreditCeiling} from './queue-limits.js';
import {DEFAULT_QUEUE_PROFILE,SIX_GIB_QUEUE_PROFILE,isSixGiBQueuePolicyVersion,type QueueProfile} from './queue-profile.js';
export const MiB=1048576;
export const taskPolicy=Object.freeze({version:'task-v1-trial-1',poolBytes:TASK_POOL_BYTES,freeFloorBytes:256*MiB,
 initialBytes:TASK_INITIAL_BYTES,growthBytes:8*MiB,taskBytes:1_000_000_000,requestBytes:512*MiB,jsonBytes:64*MiB,imageBytes:50*MiB,
 recordBytes:256*1024,maxRecords:100000,maxImageDefinitions:1000,maxImagePlacements:10000,normalizedBytes:256*MiB,findingDetails:10000,validateMs:900000,
 maxParts:1001,maxIndexBytes:8*MiB,maxDepth:64,stringBytes:64*1024,keyBytes:256,
 maxProcessing:2,maxOutstanding:10,maxTasks:4,maxOwnerTasks:2,maxReceivers:2,receiveMs:1800000,idleMs:60000,leaseMs:30000,sweepMs:10000,
 processMs:5400000,sendMs:1800000,writeMs:60000,imageMs:30000,stopMs:5000,pdfBytes:256*MiB,docxBytes:32*MiB,maxDerivatives:2000,maxSenders:2,memoryPauseBytes:768*MiB,memoryStopBytes:896*MiB});
export type TaskPolicy={readonly [K in keyof typeof taskPolicy]: K extends 'version'?string:number};
export const QUEUE_POLICY_VERSION='task-v1-queue-2worker-trial-1';
export function queuePolicy(policy:TaskPolicy,profile:QueueProfile=DEFAULT_QUEUE_PROFILE):TaskPolicy{
 const cap=Math.min(profile.maxOutstanding,policy.maxOutstanding),slots=profile.strict?cap:10;
 return {...policy,version:profile.policyVersion,maxOutstanding:cap,maxTasks:slots,maxOwnerTasks:slots,maxReceivers:2,...(profile.strict?{maxProcessing:profile.maxProcessing,idleMs:profile.idleMs,processMs:profile.processMs,memoryPauseBytes:profile.admissionMiB*MiB,memoryStopBytes:profile.emergencyMiB*MiB}:{})};
}
export function policyWith(overrides:Partial<TaskPolicy>={}):TaskPolicy{
 const p={...taskPolicy,...overrides};
 for(const [key,value] of Object.entries(p))if(key!=='version'&&(!Number.isSafeInteger(value)||Number(value)<1))throw Error('Invalid task policy');
 if(p.initialBytes>p.taskBytes||p.initialBytes>p.poolBytes||p.growthBytes>8*MiB||p.jsonBytes>p.requestBytes||p.imageBytes>p.requestBytes)throw Error('Invalid task quota ordering');
 for(const key of ['recordBytes','maxRecords','maxImageDefinitions','maxImagePlacements','normalizedBytes','findingDetails','validateMs','processMs','sendMs','writeMs','imageMs','stopMs','pdfBytes','docxBytes','maxDerivatives','maxSenders'] as const)if(p[key]>taskPolicy[key])throw Error('Unsupported task work bound');
 const allowedProcessing=p.version===SIX_GIB_QUEUE_PROFILE.policyVersion?processingCreditCeiling(SIX_GIB_QUEUE_PROFILE.admissionMiB):2;if(p.maxProcessing>allowedProcessing)throw Error('Unsupported processing bound');
 const memoryProfile=isSixGiBQueuePolicyVersion(p.version)?SIX_GIB_QUEUE_PROFILE:DEFAULT_QUEUE_PROFILE;
 if(p.memoryPauseBytes>memoryProfile.admissionMiB*MiB||p.memoryStopBytes>memoryProfile.emergencyMiB*MiB)throw Error('Unsupported task work bound');
 return Object.freeze(p);
}
