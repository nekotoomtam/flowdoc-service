import {readFile,writeFile} from 'node:fs/promises';

const rules = new URL('authoring-cases.txt', import.meta.url);
const guide = new URL('structure-and-data.txt', import.meta.url);
const contract = new URL('model20-contract.txt', import.meta.url);
const badText = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

export function buildRequest(model,identity,pdf,evidence,instructions){
  return {
    model, store:false, max_output_tokens:19000,
    instructions,
    input:[{role:'user',content:[
      {type:'input_text',text:JSON.stringify({identity,sourceMeasurements:evidence})},
      {type:'input_file',filename:'selected-pages.pdf',file_data:'data:application/pdf;base64,'+pdf.toString('base64'),detail:'high'},
    ]}],
    text:{format:{type:'json_object'}},
  };
}

function inspectStrings(value){
  if(typeof value==='string'&&(!value.isWellFormed()||badText.test(value)))throw new Error('Model output contains invalid Unicode or a prohibited control character');
  if(value&&typeof value==='object'){
    for(const [key,item] of Object.entries(value)){
      inspectStrings(key);
      inspectStrings(item);
    }
  }
}

export function importResult(raw,identity){
  const {definition,sampleRequest,assetBindings,limitations}=raw??{};
  if(definition?.nodeModelVersion!==20||definition.templateId!==identity.templateId||
     definition.docKey!==identity.docKey||sampleRequest?.docKey!==identity.docKey){
    throw new Error('Model output does not match the reserved Model 20 identity');
  }
  if(!assetBindings||typeof assetBindings!=='object'||Array.isArray(assetBindings)||
     Object.entries(assetBindings).some(([key,marker])=>!Object.hasOwn(identity.assets,key)||marker!==identity.assets[key])){
    throw new Error('Model output references an unexpected import asset');
  }
  if(!Array.isArray(limitations)||limitations.some(item=>typeof item!=='string'))throw new Error('Model output is missing its limitations');
  inspectStrings(raw);
  return raw;
}

export function openAiResult(answer,identity){
  if(answer?.status!=='completed')throw new Error('OpenAI response was incomplete or unsuccessful');
  const parts=answer.output?.flatMap(item=>item.content??[])??[];
  if(parts.some(item=>item.type==='refusal'))throw new Error('OpenAI declined to generate the import draft');
  const text=parts.filter(item=>item.type==='output_text').map(item=>item.text).join('\n');
  let raw;
  try{raw=JSON.parse(text);}
  catch{throw new Error('OpenAI did not return a readable JSON draft');}
  return importResult(raw,identity);
}

export async function generateDraft({pdf,evidence,identity,model,key,receiptPath}){
  const instructions=(await Promise.all([contract,rules,guide].map(path=>readFile(path,'utf8')))).join('\n\n');
  const request=buildRequest(model,identity,pdf,evidence,instructions);
  const response=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',redirect:'error',
    headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify(request),
    signal:AbortSignal.timeout(300_000),
  });
  if(!response.ok)throw new Error('OpenAI request failed with HTTP '+response.status);
  const answer=await response.json();
  await writeFile(receiptPath,JSON.stringify({status:answer.status,model:answer.model,usage:answer.usage,requestId:response.headers.get('x-request-id')},null,2)+'\n');
  return openAiResult(answer,identity);
}

export async function submitDraft({url,token,result,manifest,readAsset}){
  async function call(route,method='GET',body){
    const binary=Buffer.isBuffer(body);
    const response=await fetch(new URL(route,url),{
      method,redirect:'error',
      headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':binary?'image/png':'application/json'}:{})},
      ...(body!==undefined?{body:binary?body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(60_000),
    });
    const envelope=await response.json();
    if(!response.ok||!envelope.ok){
      const issues=Array.isArray(envelope.issues)?envelope.issues.map(issue=>({code:issue.code,path:issue.path})):[];
      throw new Error(method+' '+route+' failed (HTTP '+response.status+'): '+JSON.stringify(issues));
    }
    return envelope.value;
  }

  const {definition,sampleRequest}=result;
  const docKey=definition.docKey;
  const candidate=await call('/authoring/validate','POST',{definition,sampleRequest});
  if(!candidate.composed)throw new Error('FlowDoc did not compose the sample');
  const {templateId}=await call('/authoring/drafts','POST',{docKey,name:definition.name,idempotencyKey:docKey+'-create'});
  const draft=await call('/authoring/drafts/'+templateId);
  if(draft.revision>1)throw new Error('Draft was edited after PDF import');
  const storedDefinition={...definition,templateId};
  const saved=await call('/authoring/drafts/'+templateId,'PUT',{
    expectedRevision:0,definition:storedDefinition,idempotencyKey:docKey+'-save',
  });
  if((draft.revision!==0&&draft.revision!==saved.revision)||saved.revision!==1)throw new Error('Draft revision changed during PDF import');

  const sample=JSON.stringify(sampleRequest);
  const used=manifest.assets.filter(asset=>sample.includes(JSON.stringify(asset.marker)));
  let previewInput=sampleRequest;
  if(used.length){
    const items=await Promise.all(used.map(async asset=>({...asset,bytes:await readAsset(asset)})));
    const upload=await call('/authoring/uploads','POST',{
      requestKey:docKey+'-assets',
      items:items.map(({key,bytes})=>({key,source:'upload',mediaType:'image/png',byteSize:bytes.length})),
    });
    const replacements=new Map();
    for(const asset of items){
      const resource=upload.items.find(item=>item.key===asset.key);
      if(!resource)throw new Error('FlowDoc did not reserve the requested asset');
      if(upload.status!=='ready')await call('/authoring/uploads/'+upload.uploadId+'/items/'+resource.resourceId+'/content','PUT',asset.bytes);
      replacements.set(asset.marker,resource.resourceId);
    }
    const finalized=await call('/authoring/uploads/'+upload.uploadId+'/finalize','POST');
    if(finalized.status!=='ready')throw new Error('FlowDoc did not finalize import assets');
    previewInput=JSON.parse(sample,(_,value)=>replacements.get(value)??value);
    previewInput.uploadId=upload.uploadId;
  }
  const preview=await call('/authoring/drafts/'+templateId+'/previews','POST',{
    expectedRevision:saved.revision,sampleRequest:previewInput,idempotencyKey:docKey+'-preview',
  });
  return {templateId,revision:saved.revision,jobId:preview.jobId,limitations:result.limitations};
}
