import type {ResolvedDocument,ImageBlock} from '@flowdoc/core';
export function imageNodes(document:ResolvedDocument):ImageBlock[]{
 const nodes=[...Object.values(document.nodes),...Object.values(document.header?.nodes??{}),...Object.values(document.footer?.nodes??{}),...(document.sections??[]).flatMap(s=>[...Object.values(s.header?.nodes??{}),...Object.values(s.footer?.nodes??{})])];
 return nodes.filter((n):n is ImageBlock=>n.type==='image');
}
