import type {Pool} from 'pg';
import {UUID} from './files.js';
import {fontError} from './repository.js';
/** New selections are active only. Retained retired rights are resolved through
 * the owned draft's immutable reference set, never a client-supplied catalog filter. */
export async function fontCatalog(pool:Pool,input:Record<string,unknown>={}){
 if(Object.keys(input).some(k=>!['cursor','limit','familyId'].includes(k)))fontError('INVALID_FONT_INPUT');
 const limit=input.limit===undefined?50:Number(input.limit);
 if(!Number.isInteger(limit)||limit<1||limit>100||(input.cursor!==undefined&&(typeof input.cursor!=='string'||!UUID.test(input.cursor)))||(input.familyId!==undefined&&(typeof input.familyId!=='string'||!UUID.test(input.familyId))))fontError('INVALID_FONT_INPUT');
 const rows=(await pool.query(`SELECT r.id,r.family_id,r.version,r.language_scope,f.display_name,f.default_release_id FROM font_releases r JOIN font_families f ON f.id=r.family_id WHERE r.state='active' AND r.ever_activated_at IS NOT NULL AND r.deleted_at IS NULL AND ($1::uuid IS NULL OR r.id>$1) AND ($2::uuid IS NULL OR r.family_id=$2) ORDER BY r.id LIMIT $3`,[input.cursor??null,input.familyId??null,limit+1])).rows;
 const releases=[];
 for(const r of rows.slice(0,limit)){const faces=(await pool.query('SELECT id AS "faceId",approved_weight AS weight,style,raw_weight AS "rawWeight",source_weight AS "sourceWeight",approved_weight AS "approvedWeight" FROM font_faces WHERE release_id=$1 ORDER BY approved_weight,style',[r.id])).rows;const reviewed=(await pool.query(`SELECT 1 FROM font_height_profile_assignments a JOIN font_height_profiles p ON p.id=a.profile_id AND p.profile_digest=a.profile_digest JOIN font_releases r ON r.id=a.release_id AND r.manifest_digest=p.release_manifest_digest JOIN font_faces f ON f.id=p.regular_face_id AND f.release_id=r.id AND f.asset_id=p.asset_id AND f.approved_weight=400 AND f.style='normal' JOIN font_assets asset ON asset.id=f.asset_id AND asset.sha256=p.sha256 JOIN LATERAL (SELECT decision FROM font_height_profile_reviews WHERE profile_id=p.id ORDER BY sequence DESC LIMIT 1) review ON review.decision='approved' WHERE a.release_id=$1 AND a.method_id='thai-bo-baseline-top-v1' AND p.outcome='measured'`,[r.id])).rowCount;releases.push({heightProfile:{reviewed:!!reviewed,methodId:'thai-bo-baseline-top-v1',availabilityCheck:'proposal_required'},releaseId:r.id,familyId:r.family_id,familyName:r.display_name,version:r.version,languageScope:r.language_scope,isDefault:r.default_release_id===r.id,faces});}
 return {releases,nextCursor:rows.length>limit?releases.at(-1)!.releaseId:null};
}
