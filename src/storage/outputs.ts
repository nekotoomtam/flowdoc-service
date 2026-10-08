import type {Pool} from 'pg';
import type {PdfFiles} from './pdf-files.js';
import {OperationError} from '../errors.js';
export function createOutputs(pool:Pool,files:PdfFiles,tempHours:number){
 const active=new Map<string,number>(),retiring=new Set<string>();
 async function retire(id:string,state:'consumed'|'expired'){
  retiring.add(id);
  if(state==='consumed')await files.markRetired(id+'.pdf');
  await pool.query("UPDATE document_outputs SET availability=$2 WHERE job_id=$1 AND availability='available'",[id,state]);
 }
 async function removeRetired(id:string){
  if(active.has(id))return;
  const r=await pool.query("SELECT path FROM document_outputs WHERE job_id=$1 AND availability<>'available' AND deleted_at IS NULL",[id]);
  if(r.rows[0]){await files.remove(r.rows[0].path);await pool.query('UPDATE document_outputs SET deleted_at=now() WHERE job_id=$1',[id]);await files.clearRetired(r.rows[0].path);}
  retiring.delete(id);
 }
 return {
  async available(id:string){if(retiring.has(id)||await files.isRetired(id+'.pdf'))return false;return (await pool.query("SELECT 1 FROM document_outputs WHERE job_id=$1 AND availability='available' AND expires_at>now()",[id])).rowCount===1;},
  async acquire(id:string){
   // Reserve before awaiting DB/file operations so cleanup observes every open attempt.
   active.set(id,(active.get(id)??0)+1);let released=false;
   const release=()=>{if(released)return;released=true;const n=(active.get(id)??1)-1;if(n)active.set(id,n);else active.delete(id);};
   try{
    const r=await pool.query('SELECT path,retain,availability,expires_at FROM document_outputs WHERE job_id=$1',[id]),row=r.rows[0];
    if(!row||retiring.has(id)||await files.isRetired(id+'.pdf')||row.availability!=='available'||new Date(row.expires_at).getTime()<=Date.now())throw new OperationError('OUTPUT_GONE','output','Output is no longer available');
    let stream;try{stream=await files.openPdf(row.path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new OperationError('OUTPUT_GONE','output','Output is no longer available');throw e;}
    return {stream,async finish(success:boolean){if(released)return;try{if(success&&!row.retain)await retire(id,'consumed');}finally{release();}await removeRetired(id);}};
   }catch(e){release();throw e;}
  },
  async cleanup(){
   const availableRows=await pool.query("SELECT job_id,path FROM document_outputs WHERE availability='available'");
   for(const row of availableRows.rows)if(retiring.has(row.job_id)||await files.isRetired(row.path))await retire(row.job_id,'consumed');
   const expired=await pool.query("SELECT job_id FROM document_outputs WHERE availability='available' AND expires_at<=now()");
   for(const row of expired.rows)if(!active.has(row.job_id))await retire(row.job_id,'expired');
   const retired=await pool.query("SELECT job_id FROM document_outputs WHERE availability<>'available' AND deleted_at IS NULL");for(const row of retired.rows)await removeRetired(row.job_id);
   const referenced=await pool.query('SELECT path FROM document_outputs WHERE deleted_at IS NULL');await files.cleanupOrphans(new Set(referenced.rows.map(r=>r.path)),tempHours*3600000);
  }
 };
}
export type Outputs=ReturnType<typeof createOutputs>;
