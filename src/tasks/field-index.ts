/** Reader-local bounded offset tables. No decoded keys or values are retained. */
export const INDEX_SLOT_BYTES=4096,INDEX_FIELDS=256;
type Slot={start:number;table:Buffer|undefined;count:number;complete:boolean;oversized:boolean;pins:number;used:number};
export function fieldIndex(limit:number,check:()=>void){
 const slots=new Map<number,Slot>();let clock=0,closed=false;
 const stats={fieldIndexHits:0,fieldIndexBuilds:0,fieldIndexFallbacks:0,fieldIndexEvictions:0,fieldScanBytes:0,currentIndexBytes:0,peakIndexBytes:0};
 const guard=()=>{check();if(closed)throw Error('Reader closed');};
 function acquire(start:number){
  guard();let slot=slots.get(start);
  if(slot){slot.used=++clock;if(!slot.complete||slot.oversized){stats.fieldIndexFallbacks++;return undefined;}slot.pins++;stats.fieldIndexHits++;return slot;}
  if(!limit){stats.fieldIndexFallbacks++;return undefined;}
  let table:Buffer|undefined;
  if(slots.size>=limit/INDEX_SLOT_BYTES){let oldest:Slot|undefined;for(const s of slots.values())if(!s.pins&&(!oldest||s.used<oldest.used))oldest=s;
   if(!oldest){stats.fieldIndexFallbacks++;return undefined;}slots.delete(oldest.start);table=oldest.table;oldest.table=undefined;stats.fieldIndexEvictions++;
  }
  if(!table){table=Buffer.allocUnsafeSlow(INDEX_SLOT_BYTES);stats.currentIndexBytes+=INDEX_SLOT_BYTES;stats.peakIndexBytes=Math.max(stats.peakIndexBytes,stats.currentIndexBytes);}
  slot={start,table,count:0,complete:false,oversized:false,pins:1,used:++clock};slots.set(start,slot);stats.fieldIndexBuilds++;return slot;
 }
 function append(s:Slot,keyStart:number,keyEnd:number,valueStart:number,valueEnd:number){
  guard();if(s.count===INDEX_FIELDS){s.oversized=true;stats.fieldIndexFallbacks++;return false;}
  for(const [i,n]of [keyStart,keyEnd,valueStart,valueEnd].entries()){if(!Number.isSafeInteger(n)||n<0||n>0xffffffff)throw Error('Index offset out of range');s.table!.writeUInt32LE(n,s.count*16+i*4);}s.count++;return true;
 }
 function release(s:Slot){if(closed)return;s.pins--;if(!s.complete&&!s.oversized){slots.delete(s.start);s.table=undefined;stats.currentIndexBytes-=INDEX_SLOT_BYTES;}}
 function offsets(s:Slot,i:number){guard();return [0,4,8,12].map(n=>s.table!.readUInt32LE(i*16+n)) as [number,number,number,number];}
 function close(){if(closed)return;closed=true;for(const s of slots.values())s.table=undefined;slots.clear();stats.currentIndexBytes=0;}
 return {acquire,append,release,offsets,close,stats,scan:(bytes:number)=>{stats.fieldScanBytes+=bytes;}};
}
