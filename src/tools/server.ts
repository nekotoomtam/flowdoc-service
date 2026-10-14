import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createAuthoringTools} from './authoring.js';
import {homedir} from 'node:os';
import {join} from 'node:path';
const token=process.env.AUTHORING_TOKEN,baseUrl=process.env.AUTHORING_URL??'http://127.0.0.1:3000';
if(!token)throw Error('AUTHORING_TOKEN required');
const previewDirectory=process.env.AUTHORING_PREVIEW_DIR??join(homedir(),'Downloads','FlowDoc-previews');
serveStdio(()=>createAuthoringTools({baseUrl,token,previewDirectory}));
