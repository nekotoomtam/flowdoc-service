import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {OperationError} from '../errors.js';
export const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
export const fingerprint=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export const fontError=(code:string,path='font'):never=>{throw new OperationError(code,path,'Font library operation did not succeed');};
export async function receipt<T>(c:PoolClient,principal:string,operation:string,target:string,input:{requestId:string},run:()=>Promise<T>):Promise<T>{
 const digest=fingerprint(input),key=JSON.stringify([principal,operation,target,input.requestId]);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
 const old=(await c.query('SELECT digest,result FROM font_receipts WHERE principal=$1 AND operation=$2 AND target=$3 AND request_id=$4',[principal,operation,target,input.requestId])).rows[0];
 if(old){if(old.digest!==digest)fontError('IDEMPOTENCY_CONFLICT','requestId');return old.result as T;}
 const result=await run();await c.query('INSERT INTO font_receipts(principal,operation,target,request_id,digest,result) VALUES($1,$2,$3,$4,$5,$6)',[principal,operation,target,input.requestId,digest,JSON.stringify(result)]);return result;
}
export async function audit(c:PoolClient,actor:string,action:string,input:{requestId:string;reason:string},summary:unknown,releaseId:string|null=null){
 await c.query('INSERT INTO font_audit_events(id,actor,action,reason,request_id,release_id,summary) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor,action,input.reason,input.requestId,releaseId,JSON.stringify(summary)]);
}
export async function lockHash(c:PoolClient,hash:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['font-asset:'+hash]);}
