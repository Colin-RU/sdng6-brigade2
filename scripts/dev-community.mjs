import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../docs');
const port=Number(process.env.ATLAS_DEV_PORT||8788);
const api=process.env.ATLAS_LIVE_API||'https://ufwrdwndlzwxtlkougrv.supabase.co/functions/v1/brigade-api';
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.apk':'application/vnd.android.package-archive'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/v1/')){
   const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>2300000){res.writeHead(413).end();return;}chunks.push(c);}
   const headers=new Headers();for(const key of ['authorization','content-type','origin','accept'])if(req.headers[key])headers.set(key,req.headers[key]);
   const target=api+url.pathname.slice('/api/v1'.length)+url.search;
   const response=await fetch(target,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),redirect:'error'});
   const outputHeaders={'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store'};
   res.writeHead(response.status,outputHeaders);res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  const name=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)||name.includes('/server/')||name.includes('/.openai/')){res.writeHead(404).end();return;}
  const info=await stat(file);if(!info.isFile()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(await readFile(file));
 }catch{res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Сервер недоступен'}}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Local: http://127.0.0.1:${port}/`));
