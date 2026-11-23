import {describe,expect,it} from 'vitest';
import {buildRequest,importResult,openAiResult} from '../runtime/pdf-import/import.mjs';

const identity={docKey:'pdf-import-test',templateId:'draft-external',assets:{asset1:'asset-placeholder'}};
const definition={docKey:identity.docKey,templateId:identity.templateId,nodeModelVersion:20};
const sampleRequest={docKey:identity.docKey,data:{photo:identity.assets.asset1}};
const raw={definition,sampleRequest,assetBindings:identity.assets,limitations:['Render to confirm the placement.']};

describe('PDF Import request',()=>{
 it('sends the selected PDF, measurements, and stable identity without storing the response server-side',()=>{
  const request=buildRequest('configured-model',identity,Buffer.from('%PDF-1.7'),{pages:[{originalPage:3}]},'general rules');
  expect(request.store).toBe(false);
  expect(request.model).toBe('configured-model');
  expect(request.instructions).toContain('general rules');
  expect(request.input[0].content[0].text).toContain('originalPage');
  expect(request.input[0].content[1].file_data).toBe('data:application/pdf;base64,JVBERi0xLjc=');
 });
 it('rejects incomplete or unrelated results and does not normalize unsafe texts',()=>{
  expect(()=>openAiResult({status:'incomplete',output:[]},identity)).toThrow(/incomplete/);
  expect(()=>importResult({...raw,definition:{...definition,templateId:'some-draft'}},identity)).toThrow(/identity/);
  expect(()=>importResult({...raw,sampleRequest:{...sampleRequest,bad:'\u0000'}},identity)).toThrow(/control/);
 });
 it('returns the model output as generated',()=>{
  const answer={status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw)}]}]};
  expect(openAiResult(answer,identity)).toEqual(raw);
 });
});
