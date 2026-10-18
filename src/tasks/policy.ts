export const MiB=1048576;
export const taskPolicy=Object.freeze({version:'task-v1-trial-1',poolBytes:1_500_000_000,freeFloorBytes:256*MiB,
 initialBytes:8*MiB,growthBytes:8*MiB,taskBytes:1_000_000_000,requestBytes:512*MiB,jsonBytes:64*MiB,imageBytes:50*MiB,
 maxParts:1001,maxIndexBytes:8*MiB,maxDepth:64,stringBytes:64*1024,keyBytes:256,
 maxOutstanding:10,maxTasks:4,maxOwnerTasks:2,maxReceivers:2,receiveMs:1800000,idleMs:60000,leaseMs:30000,sweepMs:10000});
export type TaskPolicy=typeof taskPolicy;
export function policyWith(overrides:Partial<TaskPolicy>={}):TaskPolicy{
 const p={...taskPolicy,...overrides};
 for(const [key,value] of Object.entries(p))if(key!=='version'&&(!Number.isSafeInteger(value)||Number(value)<1))throw Error('Invalid task policy');
 if(p.initialBytes>p.taskBytes||p.initialBytes>p.poolBytes||p.growthBytes>8*MiB||p.jsonBytes>p.requestBytes||p.imageBytes>p.requestBytes)throw Error('Invalid task quota ordering');
 return Object.freeze(p);
}
