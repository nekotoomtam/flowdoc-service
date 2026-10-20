import type {FastifyInstance} from 'fastify';import type {Pool} from 'pg';
import type {createTaskIntake} from '../tasks/intake.js';import type {createTaskProcessing,TaskResponse} from '../tasks/processing.js';
import {taskSnapshot,publicCode} from '../tasks/public.js';import {taskError} from '../tasks/quota.js';import {taskWire} from '../tasks/wire.js';
export interface Documents {intake:Awaited<ReturnType<typeof createTaskIntake>>;processing:Awaited<ReturnType<typeof createTaskProcessing>>;lookupIdleMs?:number;lookupTotalMs?:number}
export async function registerDocuments(app:FastifyInstance,pool:Pool,tasks:Documents,isReady:()=>boolean){
 const lookupIdle=tasks.lookupIdleMs??60000,lookupTotal=tasks.lookupTotalMs??15000;if(!Number.isInteger(lookupIdle)||lookupIdle<1||lookupIdle>60000||!Number.isInteger(lookupTotal)||lookupTotal<1||lookupTotal>15000)throw Error('Invalid lookup timeout');
 // Encapsulated parser: generation bytes remain a stream, lookup is independently bounded.
 app.removeAllContentTypeParsers();app.addContentTypeParser('*',(req,payload,done)=>done(null,payload));
 app.post('/documents',async(req,reply)=>{
  const auth=req.headers.authorization??'',type=req.headers['content-type']??'';let id:string|null=null,wire:ReturnType<typeof taskWire>|undefined;
  const abort=new AbortController();const lost=()=>{if(!reply.raw.writableFinished)abort.abort(taskError('CONNECTION_LOST'));};
  req.raw.once('aborted',lost);reply.raw.once('close',lost);
  const cleanup=()=>{req.raw.removeListener('aborted',lost);reply.raw.removeListener('close',lost);};
  let normalizing:Promise<any>|undefined;
  const waitFor=(operation:(done:(error?:Error|null)=>void)=>void,finish=false)=>new Promise<void>((resolve,reject)=>{
   const closed=()=>done(taskError('CONNECTION_LOST')),finished=()=>done();
   const timer=setTimeout(()=>{abort.abort(taskError('CONNECTION_TIMEOUT'));reply.raw.destroy();done(taskError('CONNECTION_LOST'));},tasks.intake.processingContext.policy.writeMs);
   let settled=false;const done=(error?:Error|null)=>{if(settled)return;settled=true;clearTimeout(timer);reply.raw.removeListener('close',closed);reply.raw.removeListener('finish',finished);error?reject(error):resolve();};
   reply.raw.once('close',closed);if(finish)reply.raw.once('finish',finished);
   if(reply.raw.destroyed)return done(taskError('CONNECTION_LOST'));operation(finish?()=>{}:done);
  });
  const response:TaskResponse={start(contentType){reply.hijack();reply.raw.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store','X-Accel-Buffering':'no'});reply.raw.flushHeaders();},
   write:chunk=>waitFor(done=>{reply.raw.write(chunk,done);}),end:()=>waitFor(()=>{reply.raw.end();},true),async abort(){reply.raw.destroy();}};
  try{
   if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')throw taskError('UNSUPPORTED_MEDIA');
   const raw=req.raw.rawHeaders,keys=[],modes=[];for(let j=0;j<raw.length;j+=2){const name=raw[j]!.toLowerCase();if(name==='doc-key')keys.push(raw[j+1]);if(name==='task-mode')modes.push(raw[j+1]);if(['x-flowdoc-template','x-flowdoc-doc-key','x-flowdoc-declared-max-bytes'].includes(name))throw taskError('INVALID_REQUEST');}
   if(modes.length>1||modes.length===1&&modes[0]!=='queue-v1')throw taskError('INVALID_REQUEST');
   const queueMode=modes.length===1;
   const lookup=type.split(';')[0]?.trim().toLowerCase()==='application/json';
   const accept=req.headers.accept;if(accept&&!accept.split(',').some(v=>new RegExp('^('+ (lookup?'application/json':'multipart/mixed') +'|\\*\\/\\*)(?:\\s*;|\\s*$)','i').test(v.trim())&&!/;\s*q=0(?:\.0*)?(?:;|$)/.test(v)))throw Object.assign(taskError('NOT_ACCEPTABLE'),{statusCode:406});
   if(type.split(';')[0]?.trim().toLowerCase()==='application/json'){
    if(queueMode)throw taskError('TASK_REQUEST_CONFLICT');
    await tasks.intake.authenticate(auth);
    let size=0;const chunks:Buffer[]=[];const expired=()=>{(req.body as any).destroy(taskError('TASK_TIMEOUT'));};let idle=setTimeout(expired,lookupIdle);const total=setTimeout(expired,lookupTotal);
    try{for await(const b of req.body as AsyncIterable<Buffer>){clearTimeout(idle);idle=setTimeout(expired,lookupIdle);size+=b.length;if(size>16384)throw taskError('LIMIT_EXCEEDED');chunks.push(b);}}finally{clearTimeout(idle);clearTimeout(total);}
    let q:any;try{const {readGenerationJson}=await import('@flowdoc/core');const p=readGenerationJson(Buffer.concat(chunks).toString('utf8'));if(!p.ok)throw Error();q=p.value;}catch{throw taskError('INVALID_REQUEST');}
    if(!q||Array.isArray(q)||typeof q!=='object'||keys.length||Object.keys(q).some(k=>!['taskId','findingsCursor','findingsLimit'].includes(k)))throw taskError('TASK_REQUEST_CONFLICT');
    return reply.header('Cache-Control','no-store').send(await taskSnapshot(pool,tasks.intake,auth,q.taskId,q.findingsCursor,q.findingsLimit));
   }
   if(!isReady())throw taskError('UNAVAILABLE');
   if(keys.length!==1)throw taskError('INVALID_REQUEST');
   const opened=await tasks.intake.open({authorization:auth,docKey:keys[0],contentType:type,queueMode,...(req.headers['content-encoding']?{contentEncoding:req.headers['content-encoding']}:{})});const taskId=opened.taskId;id=taskId;
   const first=async(status:string)=>{wire=taskWire(response,taskId);await wire.event('task',status,{createdAt:opened.createdAt,expiresAt:opened.expiresAt,template:opened.template,...(queueMode&&tasks.intake.queueSnapshot().intakes>=2?{waitReason:'receive_slot'}:{})});};
   if(queueMode)await first('awaiting_input');
   if(queueMode||tasks.intake.sharedQueueEnabled()){
    normalizing=tasks.intake.receiveQueued({authorization:auth,taskId,contentType:type,body:req.body as any,signal:abort.signal,legacyPipeline:!queueMode,...(!queueMode?{onReceived:()=>first('validating')}:{})}).then(()=>({done:true as const}),error=>({done:true as const,error}));
   }else{
    await tasks.intake.receive({authorization:auth,taskId,contentType:type,body:req.body as any,signal:abort.signal});await first('validating');
    normalizing=tasks.intake.normalize({authorization:auth,taskId,signal:abort.signal}).then(()=>({done:true as const}),error=>({done:true as const,error}));
   }
   while(true){let timer:NodeJS.Timeout|undefined;const state=await Promise.race([normalizing,new Promise<{done:false}>(r=>{timer=setTimeout(()=>r({done:false}),10000);})]);clearTimeout(timer);if(state.done){if('error' in state)throw state.error;break;}if(wire){const q=tasks.intake.queueState(taskId),stage=q?.stage==='waiting'?'awaiting_input':q?.stage??'validating';await wire.event('heartbeat',stage,{stage,...(q?.waitReason?{waitReason:q.waitReason}:{})});}}

   if(!wire)throw taskError('UNAVAILABLE');await tasks.processing.execute({authorization:auth,taskId,response,signal:abort.signal,wire});return reply;
  }catch(e:any){
   abort.abort(e);await normalizing;
   const code=publicCode(e.code??'UNAVAILABLE');if(id)await tasks.intake.fail(id,e.code??'UNAVAILABLE').catch(()=>{});
   if(wire?.started){if(!wire.ended&&!reply.raw.destroyed){const state=id?(await pool.query('SELECT status,receive_started_at,validation_started_at FROM tasks WHERE id=$1',[id])).rows[0]:null;const stage=state?.validation_started_at?'validating':state?.receive_started_at?'receiving':'awaiting_input';await wire.error(code,stage,state?.status??'failed').catch(()=>response.abort());}return reply;}
   if(reply.raw.destroyed)return reply;
   const status=e.statusCode??({UNAUTHORIZED:401,FORBIDDEN:403,TASK_NOT_FOUND:404,TEMPLATE_NOT_FOUND:404,INVALID_REQUEST:400,TASK_REQUEST_CONFLICT:409,LIMIT_EXCEEDED:413,UNSUPPORTED_MEDIA:415,INVALID_DATA:422} as Record<string,number>)[code]??503;
   return reply.code(status).header('Connection','close').header('Cache-Control','no-store').send({ok:false,error:{code,stage:'receiving',message:'Document request could not complete'},taskId:id});
  }finally{cleanup();}
 });
}
