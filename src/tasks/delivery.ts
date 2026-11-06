/** Server transport observations; none proves that a client saved the file. */
export function deliveryEvidence(delivery:string){return delivery==='succeeded'?'transport_finished':delivery==='interrupted'?'transport_interrupted':delivery==='unknown'?'unknown_after_interruption':'not_started';}
export function deliveryView(row:any,facts?:any):{delivery:'pending'|'succeeded'|'failed'|'unknown';deliveryEvidence:string}{
 if(row.status==='succeeded')return{delivery:'succeeded',deliveryEvidence:'transport_finished'};
 if(!row.terminal_at)return{delivery:'pending',deliveryEvidence:'pending'};
 if(facts?.deliveryEvidence==='transport_finished'&&facts.delivery==='succeeded')return{delivery:'succeeded',deliveryEvidence:'transport_finished'};
 if(facts?.deliveryEvidence==='transport_interrupted')return{delivery:'failed',deliveryEvidence:'transport_interrupted'};
 if(facts?.deliveryEvidence==='not_started'||!row.send_started_at)return{delivery:'failed',deliveryEvidence:'not_started'};
 // Recovery and historical failed sends have no durable finish observation.
 return{delivery:'unknown',deliveryEvidence:'unknown_after_interruption'};
}
