import {fontError,fingerprint} from './repository.js';
import type {SourceEvidence} from './types.js';
export const customKey=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9_-]{0,99}$/.test(v);
const https=(v:string)=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
function safeText(v:unknown):v is string {
 if(typeof v!=='string'||!v.trim()||v.length>2048||/[\x00-\x1f\x7f]|file:/i.test(v))return false;
 const urls=/https?:\/\/[^\s<>"')]+/gi;
 if([...v.matchAll(urls)].some(m=>!https(m[0])))return false;
 // Exclude valid web URLs before detecting local path syntax in any other text.
 const plain=v.replace(urls,'URL');
 return !/[a-z]:[\\/]|\\\\|(?:^|[\s("'=:\[{])~?\/\S/i.test(plain);
}
export function validateSource(s:SourceEvidence){
 if(s.provider==='google-fonts'){
  if(s.provenance!==undefined||s.providerFamilyKey!==undefined||!https(s.locator))fontError('INVALID_FONT_INPUT');
  return;
 }
 if(s.provider!=='custom'||!customKey(s.providerFamilyKey))fontError('INVALID_FONT_INPUT');
 if(s.locator!=='urn:flowdoc:custom:'+s.providerFamilyKey&&!https(s.locator))fontError('INVALID_FONT_INPUT');
 const p=s.provenance;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==4||!['sourceName','sourceVersion','obtainedFrom','rightsNote'].every(k=>Object.hasOwn(p,k)&&safeText(p[k as keyof typeof p])))fontError('INVALID_FONT_INPUT');
 if(fingerprint(p)!==s.metadataHash)fontError('FONT_PROVENANCE_REQUIRED');
}
