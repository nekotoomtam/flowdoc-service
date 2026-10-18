import type {ResolvedDocument} from '@flowdoc/core';
/** Auto layout may generate this text in the label's own face. Fixed never continues. */
export const continuationSuffix=' (ต่อ)';
export function continuationLabelIds(document:ResolvedDocument):Set<string>{
 const ids=new Set<string>();
 for(const node of Object.values(document.nodes)){
  if(node.type!=='table')continue;
  const source=document.sourceMap[node.id];
  const instance=source&&document.formatInstances?.find(f=>f.sectionId===source.sectionId&&f.areaId===source.areaId&&f.areaEntryIndex===source.areaEntryIndex&&f.areaFormatId===source.areaFormatId);
  if(instance?.sizing.mode==='fixed')continue;
  for(const group of node.rowGroups??[]){
   if(!group.groupLabel)continue;
   const cell=document.nodes[group.groupLabel.cellId];
   if(cell?.type==='table-cell')for(const id of cell.childIds)if(document.nodes[id]?.type==='text-block')ids.add(id);
  }
 }
 return ids;
}
