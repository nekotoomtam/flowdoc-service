import {it,expect} from 'vitest';
import * as images from '../dist/images/job.js';
import {renderPinnedJob,renderDocumentJob} from '../dist/jobs/render.js';
it('reports serialization errors through the render promise',async()=>{
 const cyclic={};cyclic.self=cyclic;
 await expect(renderPinnedJob(cyclic,{})).rejects.toThrow();
 await expect(renderDocumentJob(cyclic)).rejects.toThrow();
});
it('prepares an exclusively owned document in place without retaining a second graph',async()=>{
 const document={nodes:{image:{id:'image',type:'image',props:{resourceId:'missing'}}}};
 const pool={query:async()=>({rows:[]})};
 const result=await images.prepareOwnedJobImages(pool,'job',document,{files:{jobDirectory:()=>'.'},config:{}},new AbortController().signal);
 expect(result.document).toBe(document);
 expect(result.images).toEqual({});
 expect(document.nodes.image.props.resourceId).toBe('');
});
