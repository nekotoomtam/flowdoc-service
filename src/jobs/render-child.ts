import {loadBundledResources,createPdfEngine,composeDocument,validateTemplate} from '@flowdoc/core';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const temporary=process.env.FLOWDOC_RENDER_TEMP!;
try{
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));const t=validateTemplate(input.template);if(!t.ok)throw Error('template');
 const doc=composeDocument(t.value,input.prepared);if(!doc.ok)throw Error('composition');
 const resources=await loadBundledResources({pythonExecutable:process.env.PYTHON_EXECUTABLE??'python',tempRoot:temporary});if(!resources.ok)throw Error('resources');
 const engine=await createPdfEngine(resources.value);if(!engine.ok)throw Error('engine');
 const pdf=await engine.value.generatePdf(doc.value);if(!pdf.ok)throw Error('render');
 process.stdout.write(pdf.value.bytes);
}catch{process.exitCode=1;}finally{}
