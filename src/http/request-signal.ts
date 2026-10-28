import type {FastifyRequest,FastifyReply} from 'fastify';
import {OperationError} from '../errors.js';
/** A completed request body is not cancellation; only a lost response is. */
export async function withRequestSignal<T>(request:FastifyRequest,reply:FastifyReply,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const abort=new AbortController();const lost=()=>{if(!reply.raw.writableFinished)abort.abort(new OperationError('UNAVAILABLE','request','Request interrupted'));};
 request.raw.once('aborted',lost);reply.raw.once('close',lost);
 if(request.raw.aborted||reply.raw.destroyed)lost();
 try{return await work(abort.signal);}finally{request.raw.removeListener('aborted',lost);reply.raw.removeListener('close',lost);}
}
