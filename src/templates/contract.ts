import type {TemplateDefinition} from '@flowdoc/core';
import {OperationError} from '../errors.js';
import {buildAreaContract} from './areaContract.js';
type Section = TemplateDefinition['sections'][number];
interface InputContract {
 nodeModelVersion:20;
 docKey:string;
 version:number;
 globalSchema:TemplateDefinition['globalSchema'];
 sections:{id:string;sectionKey:string;label:string;inputSchema:Section['inputSchema'];header?:NonNullable<Section['header']>['inputSchema'];footer?:NonNullable<Section['footer']>['inputSchema']}[];
 assembly:{input:'array-by-section-key';instanceKey:'required-unique-per-request';order:'request';reuseDefinitions:true};
 examples:TemplateDefinition['examples'];
 areaFormats:ReturnType<typeof buildAreaContract>;
}
export function templateContract(t:TemplateDefinition):InputContract{
 if(t.nodeModelVersion!==20)throw new OperationError('INVALID_TEMPLATE','nodeModelVersion','Only model20 documents are supported');
 return {
  nodeModelVersion:20,docKey:t.docKey,version:t.version,globalSchema:t.globalSchema,
  sections:t.sections.map(s=>({id:s.id,sectionKey:s.sectionKey,label:s.label,inputSchema:s.inputSchema,...(s.header?{header:s.header.inputSchema}:{}),...(s.footer?{footer:s.footer.inputSchema}:{})})),
  assembly:{input:'array-by-section-key',instanceKey:'required-unique-per-request',order:'request',reuseDefinitions:true},
  examples:t.examples,areaFormats:buildAreaContract(t)
 };
}
