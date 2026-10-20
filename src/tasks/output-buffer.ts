const OUTPUT_BUFFER_BYTES=65536;

/** One bounded copy owned by the render worker; downstream writes stay serial.
 * Accepted tails are not durable until finish succeeds. Abort/failure drops them.
 */
export function createPdfOutputBuffer(write:(chunk:Uint8Array)=>Promise<void>,signal:AbortSignal){
 let buffer:Buffer|undefined,used=0,closed=false,failure:unknown;
 const clear=()=>{buffer=undefined;used=0;};
 const check=()=>{signal.throwIfAborted();if(failure)throw failure;if(closed)throw Error('PDF output buffer closed');};
 const fail=(error:unknown)=>{failure??=error;closed=true;clear();};
 const flush=async()=>{
  check();if(!used)return;
  // Keep this view alive and untouched until the parent acknowledges its write.
  const chunk=buffer!.subarray(0,used);await write(chunk);check();used=0;
 };
 return {
  async write(chunk:Uint8Array){
   try{
    check();
    for(let at=0;at<chunk.length;){
     check();buffer??=Buffer.allocUnsafe(OUTPUT_BUFFER_BYTES);
     const length=Math.min(chunk.length-at,OUTPUT_BUFFER_BYTES-used);
     buffer.set(chunk.subarray(at,at+length),used);used+=length;at+=length;
     if(used===OUTPUT_BUFFER_BYTES)await flush();
    }
   }catch(error){fail(error);throw error;}
  },
  async finish(){
   try{check();await flush();check();closed=true;}catch(error){fail(error);throw error;}finally{clear();}
  },
  abort(){fail(signal.aborted?signal.reason:Error('PDF output buffer aborted'));}
 };
}
