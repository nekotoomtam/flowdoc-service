import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {open,readFile,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateDraft,importResult,submitDraft} from './import.mjs';

const usage = `PDF Import operator tool
  node runtime/pdf-import/run.mjs prepare SOURCE.pdf WORK_DIR [--pages 1,3,4]
  node runtime/pdf-import/run.mjs generate WORK_DIR
  node runtime/pdf-import/run.mjs submit WORK_DIR

Use a new private WORK_DIR for prepare. Omit --pages to select all pages (up to 30).
Prepare requires Poppler and Python with runtime/pdf-import/requirements.txt.
Generate sends only the selected pages to OpenAI. Configure OPENAI_API_KEY and PDF_IMPORT_MODEL.
Submit uses AUTHORING_URL and AUTHORING_TOKEN for FlowDoc Service and queues a draft preview.
Reuse the same work directory to resume submission. Use a new preparation for another paid call.
Set PDF_IMPORT_PYTHON to override the Python program (the default is python).
`;

function needed(name){
  const value=process.env[name]?.trim();
  if(!value)throw new Error(name+' is required');
  return value;
}
async function json(path){
  return JSON.parse(await readFile(path,'utf8'));
}
async function save(path,data){
  const tmp=path+'.'+randomUUID()+'.tmp';
  await writeFile(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
  await rename(tmp,path);
}
const assetKey=/^asset[1-9][0-9]*$/;

async function main(){
  const [command,path,...args]=process.argv.slice(2);
  if(!command||command==='--help'||command==='-h'){
    process.stdout.write(usage);
    return;
  }
  if(!path)throw new Error(usage);
  if(command==='prepare'){
    const [out,pagesFlag,pages]=args;
    if(!out||(args.length!==1&&(args.length!==3||pagesFlag!=='--pages'||!pages)))throw new Error(usage);
    const file=fileURLToPath(new URL('prepare.py',import.meta.url));
    const result=spawnSync(process.env.PDF_IMPORT_PYTHON??'python',[file,resolve(path),resolve(out),...(pages?['--pages',pages]:[])],{
      stdio:'inherit',windowsHide:true,timeout:600_000,
    });
    if(result.error||result.status!==0)throw new Error('PDF preparation failed');
    const metadata=await json(join(out,'prepared.json'));
    console.log(JSON.stringify({sourcePageCount:metadata.sourcePageCount,selectedPages:metadata.selectedPages,assets:metadata.assets.length}));
    return;
  }
  if(args.length||!['generate','submit'].includes(command))throw new Error(usage);
  const dir=resolve(path);
  const prepared=await json(join(dir,'prepared.json'));
  if(!Array.isArray(prepared.assets)||prepared.assets.some(key=>typeof key!=='string'||!assetKey.test(key)))throw new Error('Invalid prepared asset list');
  const identityPath=join(dir,'identity.json');
  if(command==='generate'){
    const model=needed('PDF_IMPORT_MODEL'),key=needed('OPENAI_API_KEY');
    const pdf=await readFile(join(dir,'selected.pdf'));
    const templateId=randomUUID();
    const identity={templateId,docKey:'pdf-import-'+templateId,assets:Object.fromEntries(prepared.assets.map(key=>[key,randomUUID()]))};
    const marker=await open(identityPath,'wx',0o600);
    try{await marker.writeFile(JSON.stringify(identity,null,2)+'\n');}finally{await marker.close();}
    const result=await generateDraft({pdf,evidence:prepared.evidence,identity,model,key,receiptPath:join(dir,'api-receipt.json')});
    await save(join(dir,'draft.json'),result);
    console.log(JSON.stringify({docKey:identity.docKey,model}));
    return;
  }
  const url=new URL(needed('AUTHORING_URL'));
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS or a loopback Authoring URL');
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('AUTHORING_URL must be a Service origin');
  const token=needed('AUTHORING_TOKEN');
  const identity=await json(identityPath);
  const result=importResult(await json(join(dir,'draft.json')),identity);
  const assets=prepared.assets.map(key=>({key,marker:identity.assets[key]}));
  const submissionPath=join(dir,'submission.json');
  let previous;
  try{previous=await json(submissionPath);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(previous){
    if(previous.origin!==url.origin)throw new Error('This work directory already belongs to a different Service');
    console.log(JSON.stringify(previous));
    return;
  }
  const submission=await submitDraft({url,token,result,manifest:{assets},readAsset:({key})=>readFile(join(dir,key+'.png'))});
  const checkpoint={...submission,origin:url.origin};
  await save(submissionPath,checkpoint);
  console.log(JSON.stringify(checkpoint));
}

main().catch(error=>{
  console.error(error.message);
  process.exitCode=1;
});
