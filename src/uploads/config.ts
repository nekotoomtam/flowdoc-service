export interface UploadConfig {
 fileBytes:number; setBytes:number; stagingBytes:number; maxItems:number;
 maxSessions:number; streams:number; base64Bytes:number; idleMs:number;
 readyMs:number; absoluteMs:number; requestIdleMs:number; requestMs:number; metadataMs:number;
}
export function readUploadConfig(env:NodeJS.ProcessEnv):UploadConfig {
 const n=(key:string,fallback:number,max:number)=>{
  const value=Number(env['UPLOAD_'+key]??fallback);
  if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('Invalid UPLOAD_'+key);
  return value;
 };
 const config={fileBytes:n('FILE_BYTES',50*1048576,1024*1048576),setBytes:n('SET_BYTES',200*1048576,4096*1048576),
  stagingBytes:n('STAGING_BYTES',1024*1048576,16384*1048576),maxItems:n('MAX_ITEMS',20,1000),
  maxSessions:n('MAX_SESSIONS',100,10000),streams:n('STREAMS',2,16),base64Bytes:n('BASE64_BYTES',1048576,1048576),
  idleMs:n('IDLE_MS',3600000,86400000),readyMs:n('READY_MS',3600000,86400000),
  absoluteMs:n('ABSOLUTE_MS',14400000,604800000),requestIdleMs:n('REQUEST_IDLE_MS',60000,3600000),
  requestMs:n('REQUEST_MS',600000,3600000),metadataMs:n('METADATA_MS',86400000,604800000)};
 if(config.fileBytes>config.setBytes||config.setBytes>config.stagingBytes)throw Error('Invalid upload quota ordering');
 return config;
}
