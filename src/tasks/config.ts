import {timingSafeEqual} from 'node:crypto';import type {TaskIdentity} from './repository.js';
/** Fixed trusted mapping only; no legacy or authoring credential fallback. */
export function taskCredentials(raw:unknown):((header:string)=>TaskIdentity|null)|undefined{
 if(raw===undefined)return undefined;
 if(!Array.isArray(raw)||!raw.length||raw.length>100)throw Error('Invalid task credential configuration');
 const seen=new Set<string>(),entries=raw.map(r=>{
  const valid=(s:unknown)=>typeof s==='string'&&Buffer.byteLength(s)>0&&Buffer.byteLength(s)<=200&&!/[\x00-\x1f\x7f]/.test(s);
  if(!r||typeof r!=='object'||Object.keys(r).some(k=>!['token','ownerKey','principalId','billingSubjectKey','docKeys','taskRead'].includes(k))||!valid(r.token)||r.token.length<32||seen.has(r.token)||!valid(r.ownerKey)||!valid(r.principalId)||r.billingSubjectKey!==undefined&&!valid(r.billingSubjectKey)||typeof r.taskRead!=='boolean'||!Array.isArray(r.docKeys)||r.docKeys.length>1000||!r.docKeys.every(valid))throw Error('Invalid task credential configuration');
  seen.add(r.token);const identity:TaskIdentity=Object.freeze({ownerKey:r.ownerKey,principalId:r.principalId,docKeys:Object.freeze([...r.docKeys]),taskRead:r.taskRead,...(r.billingSubjectKey?{billingSubjectKey:r.billingSubjectKey}:{})});return {token:Buffer.from('Bearer '+r.token),identity};
 });
 return header=>{const token=Buffer.from(header);return entries.find(e=>e.token.length===token.length&&timingSafeEqual(e.token,token))?.identity??null;};
}
