import type {ChildProcess} from 'node:child_process';

export const WORKER_BYTES=536870912;
export const AGGREGATE_BYTES=1073741824;
export const WORKER_KINDS=['legacy-render','font-preflight','task-render','image-prepare','font-inspect'] as const;
export type WorkerKind=typeof WORKER_KINDS[number];
export type WorkerState='blocked'|'binding'|'bound'|'starting'|'started'|'stopping'|'stopped';
/** Internal adapter input. Document bodies are deliberately absent. */
export interface ApprovedLaunchSpec {
 kind:WorkerKind;deadlineAt:number;signal?:AbortSignal;env?:Record<string,string>;
 fenceFd?:number;fileBytes?:number;fontPath?:string;includeHeightMetric?:boolean;
}
export interface BoundProof {readonly epoch:string;readonly sequence:number;readonly group:string;readonly pid:number;readonly startTime:string;readonly memoryMax:536870912;readonly swapMax:0}
export interface StoppedProof {readonly childReaped:true;readonly groupGone:true;readonly scopeEmpty:true}
export interface BlockedWorker {
 readonly child:ChildProcess;readonly identity:{readonly pid:number;readonly pgid:number;readonly startTime:string};readonly state:WorkerState;
 bind():Promise<BoundProof>;start():Promise<void>;stop(reason:string):Promise<StoppedProof>;waitStopped():Promise<StoppedProof>;
}
export interface WorkerLauncher {isReady():boolean;spawnBlocked(spec:ApprovedLaunchSpec):Promise<BlockedWorker>;closeAdmissions():void;drain():Promise<void>}
export const workerError=(code:string)=>Object.assign(new Error(code),{code});
