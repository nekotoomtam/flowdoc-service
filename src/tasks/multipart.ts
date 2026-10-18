import {Transform} from 'node:stream';import {MIMEType} from 'node:util';import {taskError} from './quota.js';
export function taskBoundary(type:string){try{const m=new MIMEType(type),b=m.params.get('boundary');if(m.essence!=='multipart/form-data'||!b||!/^[-0-9A-Za-z'()+_,./:=? ]{1,70}$/.test(b)||b.endsWith(' '))throw Error();return b;}catch{throw taskError('INVALID_REQUEST','Invalid multipart content type');}}
/** Budget guard only; Busboy performs multipart parsing. Bounded carry across chunks. */
export function headerBudget(boundary:string,onClosed:(order:number)=>void=()=>{}){
 const initial=Buffer.from('--'+boundary+'\r\n'),delimiter=Buffer.from('\r\n--'+boundary),end=Buffer.from('\r\n\r\n');let carry=Buffer.alloc(0),order=0,state:'initial'|'headers'|'body'|'done'='initial';
 return new Transform({transform(chunk:Buffer,_e,done){try{
  let b=Buffer.concat([carry,chunk]);carry=Buffer.alloc(0);
  while(b.length){
   if(state==='done')break;
   if(state==='initial'){if(b.length<initial.length){carry=b;break;}if(!b.subarray(0,initial.length).equals(initial))throw taskError('INVALID_REQUEST');b=b.subarray(initial.length);state='headers';}
   else if(state==='headers'){const pos=b.indexOf(end);if(pos<0){if(b.length>16384)throw taskError('LIMIT_EXCEEDED');carry=b;break;}if(pos+4>16384)throw taskError('LIMIT_EXCEEDED');b=b.subarray(pos+4);state='body';}
   else{const pos=b.indexOf(delimiter);if(pos<0){carry=b.subarray(Math.max(0,b.length-delimiter.length-2));break;}if(b.length<pos+delimiter.length+2){carry=b.subarray(pos);break;}const suffix=b.subarray(pos+delimiter.length,pos+delimiter.length+2).toString('ascii');if(suffix==='--'){onClosed(order++);state='done';break;}if(suffix!=='\r\n'){b=b.subarray(pos+2);continue;}onClosed(order++);state='headers';b=b.subarray(pos+delimiter.length+2);}
  }done(null,chunk);
 }catch(e){done(e as Error);}}});
}
