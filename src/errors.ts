import type {Result,Issue} from '@flowdoc/core';
export class OperationError extends Error {
 constructor(public readonly code:string,public readonly path:string,message:string){super(message);}
}
export class IssueError extends OperationError {
 constructor(public readonly issues:Issue[]){super(issues[0]?.code??'INVALID_DATA',issues[0]?.path??'request','Operation is not ready');}
}
export function failure(error:unknown):Result<never>{
 if(error instanceof IssueError)return {ok:false,issues:error.issues,warnings:[]};
 return {ok:false,issues:[error instanceof OperationError?{code:error.code,path:error.path,message:error.message}:{code:'STORAGE_FAILED',path:'storage',message:'Storage operation failed'}],warnings:[]};
}
