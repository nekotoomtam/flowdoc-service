import type {TemplateDefinition} from '@flowdoc/core';
export function buildAreaContract(t:TemplateDefinition){return Object.fromEntries(Object.entries(t.areaFormats??{}).map(([id,f])=>[id,{ownerAreaId:f.ownerAreaId,key:f.key,...(f.label===undefined?{}:{label:f.label}),...(f.description===undefined?{}:{description:f.description}),inputSchema:f.inputSchema}]));}
