import {createServer,request} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// This development helper binds loopback; target is fixed at startup, never supplied by a request.
export function createLocalServer(target){
 const upstream=new URL(target);
 if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw Error('API target must be http://127.0.0.1:<port>');
 const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.mjs',['app.mjs','text/javascript; charset=utf-8']],['/client.mjs',['client.mjs','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
 const routes=[['GET',/^\/health$/],['GET',/^\/templates\/[^/]+\/contract$/],['POST',/^\/jobs$/],['GET',/^\/jobs\/[^/]+(?:\/pdf)?$/],['POST',/^\/uploads$/],['GET',/^\/uploads\/[^/]+$/],['POST',/^\/uploads\/[^/]+\/finalize$/],['PUT',/^\/uploads\/[^/]+\/items\/[^/]+\/content$/]];
 return createServer(async(req,res)=>{
  const host='127.0.0.1:'+req.socket.localPort;
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!=='http://'+host)||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403);res.end();return;}
  const url=new URL(req.url,'http://'+host);
  if(req.method==='GET'&&assets.has(url.pathname)){
   const [name,type]=assets.get(url.pathname);res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
   try{res.setHeader('Content-Type',type);res.end(await readFile(new URL(name,import.meta.url)));}catch{res.writeHead(500);res.end('Client asset unavailable');}return;
  }
  const path=url.pathname.slice(4);
  if(!url.pathname.startsWith('/api/')||!routes.some(([method,re])=>method===req.method&&re.test(path))){res.writeHead(404);res.end();return;}
  const headers={};for(const key of ['content-type','content-length'])if(req.headers[key])headers[key]=req.headers[key];
  const proxy=request(upstream,{method:req.method,path:path+url.search,headers},response=>{
   const safe={};for(const key of ['content-type','content-disposition','content-length','retry-after'])if(response.headers[key])safe[key]=response.headers[key];
   res.writeHead(response.statusCode,safe);response.on('error',()=>res.destroy());response.pipe(res);
  });
  proxy.setTimeout(610000,()=>proxy.destroy());
  proxy.on('error',()=>{if(res.headersSent){res.destroy();return;}res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,issues:[{code:'CONNECTION_LOST',path:'connection',message:'API connection interrupted; do not blindly repeat POST'}]}));});
  req.on('aborted',()=>proxy.destroy());res.on('close',()=>{if(!res.writableFinished)proxy.destroy();});req.pipe(proxy);
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.CLIENT_PORT??4053);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid CLIENT_PORT');
 const server=createLocalServer(process.env.API_BASE??'http://127.0.0.1:3000');
 server.listen(port,'127.0.0.1',()=>console.log('Local API client: http://127.0.0.1:'+port));
}
