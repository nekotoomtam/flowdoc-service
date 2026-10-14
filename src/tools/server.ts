import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createAuthoringTools} from './authoring.js';
const token=process.env.AUTHORING_TOKEN,baseUrl=process.env.AUTHORING_URL??'http://127.0.0.1:3000';
if(!token)throw Error('AUTHORING_TOKEN required');
serveStdio(()=>createAuthoringTools({baseUrl,token}));
