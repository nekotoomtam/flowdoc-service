import {readFile} from 'node:fs/promises';
import {readGenerationJson} from '@flowdoc/core';
import {createFontAdminClient} from './client.js';
import {failure,OperationError} from '../errors.js';
try{
 const args=process.argv.slice(2);if(args.length!==3||args[1]!=='--request')throw Error();
 const bytes=await readFile(args[2]!);if(bytes.length>1048576)throw Error();const parsed=readGenerationJson(bytes.toString('utf8'));if(!parsed.ok)throw Error();
 const client=createFontAdminClient({baseUrl:process.env.FONT_ADMIN_BASE_URL??'http://127.0.0.1:3000',token:process.env.FONT_ADMIN_TOKEN??''}),result=await client.execute(args[0]!,parsed.value);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}catch{console.log(JSON.stringify(failure(new OperationError('FONT_ADMIN_REQUEST_FAILED','request','Font administrator request did not succeed; check configuration and retry the same request'))));process.exitCode=1;}
