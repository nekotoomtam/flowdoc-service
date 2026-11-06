/** Silence budget applies only to an outstanding upstream read, excluding owned local IO. */
export function createReceiveIdle(ms:number,onIdle:()=>void){
 if(!Number.isSafeInteger(ms)||ms<1||ms>2147483647)throw Error('Invalid receive idle budget');
 let waiting=0,busy=0,closed=false,timer:NodeJS.Timeout|undefined;
 function update(){clearTimeout(timer);timer=undefined;if(!closed&&waiting>0&&busy===0)timer=setTimeout(()=>{closed=true;timer=undefined;onIdle();},ms);}
 return{
  async wait<T>(operation:()=>Promise<T>):Promise<T>{waiting++;update();try{return await operation();}finally{waiting--;update();}},
  async work<T>(operation:()=>Promise<T>):Promise<T>{busy++;update();try{return await operation();}finally{busy--;update();}},
  stop(){closed=true;update();}
 };
}
