import type {Pool,PoolClient} from 'pg';
import {transaction} from '../db/connection.js';

export interface DocumentConsumer {ownerKey:string;principalId:string}

export async function documentBaseline(db:Pool|PoolClient,id:string,consumer:DocumentConsumer){
 const rows=await db.query<{version:number;pinned:boolean}>(`
   SELECT v.version,b.version IS NOT NULL AS pinned
   FROM template_versions v LEFT JOIN document_baselines b
     ON b.template_id=v.template_id AND b.version=v.version AND b.owner_key=$2 AND b.principal_id=$3
   WHERE v.template_id=$1 ORDER BY v.version DESC`,[id,consumer.ownerKey,consumer.principalId]);
 return {pinned:rows.rows.find(row=>row.pinned)?.version??null,versions:rows.rows.map(row=>row.version)};
}

export async function setDocumentBaseline(pool:Pool,id:string,consumer:DocumentConsumer,
 expected:{pinned:number|null;latest:number},target:number){
 return transaction(pool,async client=>{
   await client.query('SELECT id FROM templates WHERE id=$1 FOR UPDATE',[id]);
   const state=await documentBaseline(client,id,consumer);
   if(state.pinned!==expected.pinned || state.versions[0]!==expected.latest)return 'stale';
   if(!state.versions.includes(target))return 'invalid';
   await client.query(`INSERT INTO document_baselines(owner_key,principal_id,template_id,version) VALUES ($1,$2,$3,$4)
     ON CONFLICT(owner_key,principal_id,template_id) DO UPDATE SET version=EXCLUDED.version`,
     [consumer.ownerKey,consumer.principalId,id,target]);
   return 'updated';
 });
}
