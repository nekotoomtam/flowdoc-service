import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {fontCatalog} from '../fonts/catalog.js';
import {failure} from '../errors.js';
/** Register inside the authoring authentication scope only. */
export function registerFontsAuthoring(app:FastifyInstance,pool:Pool){
 app.get('/authoring/fonts',async(req,reply)=>{try{return {ok:true,value:await fontCatalog(pool,req.query as Record<string,unknown>),warnings:[]};}catch(error){reply.code(422);return failure(error);}});
}
