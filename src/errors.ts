import type {Result} from '@flowdoc/core';
export class OperationError extends Error {
 constructor(public readonly code:string,public readonly path:string,message:string){super(message);}
}
export function failure(error:unknown):Result<never>{
 return {ok:false,issues:[error instanceof OperationError?{code:error.code,path:error.path,message:error.message}:{code:'STORAGE_FAILED',path:'storage',message:'Storage operation failed'}],warnings:[]};
}
