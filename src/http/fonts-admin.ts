import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {failure,OperationError} from '../errors.js';
import {createFontLibrary} from '../fonts/service.js';
import {createFontLifecycle} from '../fonts/lifecycle.js';
import {FONT_LIMITS} from '../fonts/types.js';
export interface FontAdminAccess {token:string;principal:string}
export function checkFontAdminAccess(access:FontAdminAccess,authoringToken?:string){if(typeof access.token!=='string'||access.token.length<32||access.token.length>512||/[\s\x00-\x1f\x7f]/.test(access.token)||typeof access.principal!=='string'||!access.principal.trim()||access.principal.length>200||access.token===authoringToken)throw Error('Invalid font administrator configuration');}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export async function registerFontsAdmin(app:FastifyInstance,deps:{pool:Pool;root:string;access:FontAdminAccess;authoringToken?:string;isReady:()=>boolean}){
 checkFontAdminAccess(deps.access,deps.authoringToken);
 app.addHook('onRequest',async(req,reply)=>{const h=req.headers.authorization,token=typeof h==='string'&&h.startsWith('Bearer ')?h.slice(7):'';if(!equal(token,deps.access.token)){const forbidden=!!deps.authoringToken&&equal(token,deps.authoringToken);return reply.code(forbidden?403:401).send(failure(new OperationError(forbidden?'FORBIDDEN':'UNAUTHORIZED','authorization','Font administrator access required')));}if(!deps.isReady())return reply.code(503).send(failure(new OperationError('UNAVAILABLE','service','Service unavailable')));});
 const lib=await createFontLibrary({pool:deps.pool,root:deps.root,principal:deps.access.principal}),life=createFontLifecycle({pool:deps.pool,root:deps.root,principal:deps.access.principal});
 const handler=(run:(req:any)=>Promise<unknown>,success=200)=>async(req:any,reply:any)=>{try{const value=await run(req);reply.code(success);return {ok:true,value,warnings:[]};}catch(error){const result=failure(error),code=result.ok?'UNAVAILABLE':result.issues[0]?.code??'UNAVAILABLE';const status=/NOT_FOUND$/.test(code)?404:code==='FONT_REVIEW_FAILED'?422:/STALE|CONFLICT|DEFAULT_DECISION/.test(code)?409:/LIMIT|TOO_LARGE/.test(code)?413:/^INVALID_|PROVENANCE_REQUIRED|UPLOAD_INCOMPLETE/.test(code)?422:503;reply.code(status);return result;}};
 app.post('/admin/fonts/families',handler(r=>lib.createFamily(r.body),201));
 app.post('/admin/fonts/imports',handler(r=>lib.createImport(r.body),201));
 app.get('/admin/fonts/imports/:id',handler(async r=>({...await lib.getImport(r.params.id),audit:(await deps.pool.query(`SELECT actor,action,reason,created_at AS "createdAt",summary FROM font_audit_events WHERE summary->>'importId'=$1 AND actor=$2 ORDER BY created_at DESC LIMIT 20`,[r.params.id,deps.access.principal])).rows})));
 app.post('/admin/fonts/imports/:id/inspect',handler(r=>lib.inspectImport(r.params.id,r.body)));
 // Stream binary data straight through the existing size/hash/session guards.
 app.addContentTypeParser('application/octet-stream',(req,payload,done)=>done(null,payload));
 app.put('/admin/fonts/imports/:id/files/:key',{bodyLimit:FONT_LIMITS.fileBytes},handler(r=>lib.receive(r.params.id,r.params.key,r.body,AbortSignal.timeout(120000))));
 app.post('/admin/fonts/releases',handler(r=>lib.stageRelease(r.body),201));
 app.get('/admin/fonts/releases/:id',handler(async r=>({...await lib.getRelease(r.params.id),reviews:(await deps.pool.query('SELECT id,status,purpose,manifest_digest AS "manifestDigest",report_digest AS "reportDigest",approved_by AS "approvedBy" FROM font_reviews WHERE release_id=$1 ORDER BY created_at DESC LIMIT 20',[r.params.id])).rows,audit:(await deps.pool.query('SELECT actor,action,reason,created_at AS "createdAt",summary FROM font_audit_events WHERE release_id=$1 ORDER BY created_at DESC LIMIT 20',[r.params.id])).rows})));
 app.patch('/admin/fonts/releases/:id',handler(r=>life.editRelease(r.params.id,r.body)));
 for(const [action,method] of [['submit-review','submitReview'],['withdraw-review','withdrawReview'],['activate','activate'],['retire','retire'],['reactivation-review','reactivationReview']] as const)app.post('/admin/fonts/releases/:id/'+action,handler(r=>life[method](r.params.id,r.body)));
 app.delete('/admin/fonts/releases/:id',handler(r=>life.deleteRelease(r.params.id,r.body)));
 app.put('/admin/fonts/families/:id/default',handler(r=>life.setDefault(r.params.id,r.body)));
 app.get('/admin/fonts/reviews/:id',handler(r=>life.getReview(r.params.id)));
 app.post('/admin/fonts/reviews/:id/run',handler(r=>life.run(r.params.id,r.body)));
 app.post('/admin/fonts/reviews/:id/approve',handler(r=>life.approve(r.params.id,r.body)));
 app.post('/admin/fonts/reviews/:id/previews',handler(r=>{if(!r.body||r.body.purpose!=='font-review'||r.body.reviewId!==r.params.id)throw new OperationError('INVALID_FONT_INPUT','review','Invalid font review');const {purpose,reviewId,manifestDigest,...input}=r.body;return life.getReview(r.params.id).then(q=>{if(q.manifestDigest!==manifestDigest)throw new OperationError('FONT_REVIEW_STALE','review','Font review changed');return life.run(reviewId,{...input,manifestDigest});});}));
 app.get('/admin/fonts/reviews/:id/artifacts/:hash',async(req:any,reply)=>{try{return reply.type('application/pdf').header('Cache-Control','no-store').send(await life.artifact(req.params.id,req.params.hash));}catch(error){return reply.code(404).send(failure(error));}});
}
