export const DEFAULT_MAX_OUTSTANDING=10;
export function validateMaxOutstanding(value:number):number {
 if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid JOB_MAX_OUTSTANDING');
 return value;
}
export function readJobConfig(env:NodeJS.ProcessEnv):{maxOutstanding:number} {
 const raw=env.JOB_MAX_OUTSTANDING;
 if(raw!==undefined&&!/^[1-9]\d*$/.test(raw))throw Error('Invalid JOB_MAX_OUTSTANDING');
 return {maxOutstanding:validateMaxOutstanding(raw===undefined?DEFAULT_MAX_OUTSTANDING:Number(raw))};
}
