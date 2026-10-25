import type {OutputFormat} from './output-format.js';
import {taskError} from './quota.js';
export const DOCX_MAX_BYTES=32*1048576;
const DOCX_MEDIA='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export function artifactSpec(format:OutputFormat){
 if(format==='pdf')return {mediaType:'application/pdf',filename:'document.pdf'};
 if(format==='docx')return {mediaType:DOCX_MEDIA,filename:'document.docx'};
 throw taskError('STORAGE_IO');
}
export interface ArtifactReceipt {byteLength:number;sha256:string;pageCount:number|null;mediaType?:string;fieldRefresh?:'required';wordVerified?:false;buffered?:true}
/** Validate observations against the task's frozen selection, never infer it from bytes. */
export function validateReceipt(format:OutputFormat,r:ArtifactReceipt,maxBytes:number){
 const spec=artifactSpec(format);
 if(!r||!Number.isSafeInteger(r.byteLength)||r.byteLength<1||r.byteLength>maxBytes||!Number.isSafeInteger(maxBytes)||maxBytes<1||typeof r.sha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sha256))throw taskError('STORAGE_IO');
 if(format==='pdf'){
  if(typeof r.pageCount!=='number'||!Number.isSafeInteger(r.pageCount)||r.pageCount<1||r.pageCount>2000||r.mediaType!==undefined&&r.mediaType!==spec.mediaType)throw taskError('STORAGE_IO');
 }else if(r.pageCount!==null||r.byteLength>DOCX_MAX_BYTES||r.mediaType!==spec.mediaType||r.fieldRefresh!=='required'||r.wordVerified!==false||r.buffered!==true)throw taskError('STORAGE_IO');
}
export const docxDisclosure={fieldRefresh:'required' as const,wordVerified:false as const,buffered:true as const};
