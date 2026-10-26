import {normalizeOutputName,type TaskValue} from '@flowdoc/core';
import type {OutputFormat} from './output-format.js';
import {taskError} from './quota.js';
export function selectOutputName(requested:string|null|undefined,defaultName='document'):string {
 const requestedName=normalizeOutputName(requested??'');
 const fallback=normalizeOutputName(defaultName);
 if(requestedName===undefined||fallback===undefined||!fallback)throw taskError('INVALID_REQUEST');
 return requestedName||fallback;
}
export function outputDisposition(name:unknown,format:OutputFormat):string {
 const base=normalizeOutputName(name===undefined?'document':name);
 if(base===undefined||!base)throw taskError('INVALID_REQUEST');
 const full=base+'.'+format;
 if(/^[\x20-\x7e]+$/.test(full))return 'attachment; filename="'+full+'"';
 const encoded=encodeURIComponent(full).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 return 'attachment; filename="document.'+format+'"; filename*=UTF-8\'\''+encoded;
}
/** Hide only transport-level naming; business fields with this name stay intact.
 * Delegate byte-range reads rather than materializing the payload. */
export function renderTaskPayload(root:TaskValue):TaskValue {
 return {byteLength:()=>root.byteLength(),kind:()=>root.kind(),scalar:()=>root.scalar(),elements:()=>root.elements(),
  async *properties(){for await(const pair of root.properties())if(pair[0]!=='fileName')yield pair;}};
}
