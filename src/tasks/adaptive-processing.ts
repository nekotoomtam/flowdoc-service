/** Changes future dispatch only. Running tasks remain owned by the existing governor. */
export function createAdaptiveProcessing(options:{max:number;cpuCount:number}){
 if(!Number.isSafeInteger(options.max)||options.max<1||!Number.isFinite(options.cpuCount)||options.cpuCount<=0)throw Error('Invalid adaptive processing bounds');
 let target=1,previous:{at:number;cpuMicros:number}|undefined,lastChange=-Infinity,low=0,high=0,lag=0,cpuFraction:number|null=null,reason='startup';
 const baseline=Math.min(options.max,Math.max(1,Math.floor(options.cpuCount)));
 function change(next:number,why:string,at:number){next=Math.max(1,Math.min(options.max,next));if(next!==target){target=next;lastChange=at;}reason=why;low=high=lag=0;}
 return{
  observe(sample:{at:number;cpuMicros:number;active:number;queued:boolean;pressure:boolean;lagMs:number}){
   if(!Number.isFinite(sample.at)||sample.at<0||!Number.isSafeInteger(sample.cpuMicros)||sample.cpuMicros<0||!Number.isSafeInteger(sample.active)||sample.active<0||!Number.isFinite(sample.lagMs)||sample.lagMs<0)throw Error('Invalid adaptive processing sample');
   if(previous){if(sample.at<=previous.at||sample.cpuMicros<previous.cpuMicros)throw Error('Nonmonotonic CPU accounting');cpuFraction=(sample.cpuMicros-previous.cpuMicros)/((sample.at-previous.at)*1000*options.cpuCount);}
   previous={at:sample.at,cpuMicros:sample.cpuMicros};
   if(sample.pressure){change(1,'memory_pressure',sample.at);return target;}
   if(!sample.queued){change(1,'no_queued_demand',sample.at);return target;}
   lag=sample.lagMs>=150?lag+1:0;if(lag>=3){change(1,'parent_lag',sample.at);return target;}
   if(cpuFraction===null)return target;
   low=cpuFraction<.75&&sample.lagMs<50&&sample.active>=target?low+1:0;
   high=cpuFraction>=.90?high+1:0;
   if(sample.at-lastChange<2000)return target;
   if(high>=5&&target>baseline){change(baseline,'cpu_saturation',sample.at);return target;}
   if(low>=5&&target<options.max){change(target+1,'sustained_headroom',sample.at);return target;}
   reason=cpuFraction>=.90?'cpu_busy':low?'measuring_headroom':'steady';return target;
  },
  snapshot:()=>({target,maximum:options.max,cpuFraction,reason})
 };
}
