import {handleApi} from '../../../worker/api/index.mjs';
import {createSupabaseEnv} from '../../../worker/adapters/supabase.mjs';
import {sendPush} from '../../../worker/push.mjs';
import {cors,json} from '../../../worker/api/core.mjs';

let vapidCache:{until:number,value:Record<string,unknown>|null}={until:0,value:null};
let vapidPending:Promise<void>|null=null;
async function loadVapid(env:Record<string,any>){
  if(vapidCache.until<=Date.now()){
    if(!vapidPending)vapidPending=(async()=>{
      try{
        const row=await env.DB.prepare('SELECT value FROM app_secrets WHERE key=?').bind('webpush_vapid').first();
        const value=typeof row?.value==='string'?JSON.parse(row.value):row?.value??null;
        vapidCache={until:Date.now()+60000,value};
      }catch{vapidCache={until:Date.now()+10000,value:null};}
      finally{vapidPending=null;}
    })();
    await vapidPending;
  }
  const value=vapidCache.value;
  env.VAPID_PUBLIC_KEY=value?.publicKey??null;
  env.VAPID_PRIVATE_JWK=value?.privateJwk??null;
  env.VAPID_SUBJECT=value?.subject??null;
}
export function requestIp(request:Request){
  // Prefer the Cloudflare canonical address. Last forwarding hop is a conservative
  // fallback; a caller-supplied first hop is never used as a throttle identity.
  const candidate=request.headers.get('cf-connecting-ip')??request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()??request.headers.get('x-real-ip');
  return candidate&&candidate.length<=64&&/^[0-9a-fA-F:.]+$/.test(candidate)?candidate:null;
}
export function apiRequest(request:Request){
  const url=new URL(request.url);
  let suffix=url.pathname.replace(/^\/functions\/v1\/brigade-api(?=\/|$)/,'').replace(/^\/brigade-api(?=\/|$)/,'');
  if(!suffix.startsWith('/api/v1'))suffix='/api/v1'+suffix;
  url.pathname=suffix;
  return new Request(url,request);
}
Deno.serve(async(request:Request)=>{
  try{
    const env:any=createSupabaseEnv({url:Deno.env.get('SUPABASE_URL'),serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),requestIp:requestIp(request)});
    env.COOKIE_PATH='/functions/v1/brigade-api';
    const path=new URL(request.url).pathname;
    if(request.method!=='OPTIONS'&&(path.endsWith('/push/public-key')||(request.method==='POST'&&path.endsWith('/notes'))))await loadVapid(env);
    const ctx={waitUntil(promise:Promise<unknown>){if(globalThis.EdgeRuntime?.waitUntil)globalThis.EdgeRuntime.waitUntil(promise);else promise.catch(()=>{});}};
    return await handleApi(apiRequest(request),env,ctx,{sendPush})??new Response('Not found',{status:404});
  }catch{return cors(request,json({error:{code:'unavailable',message:'Сервис временно недоступен.'}},503));}
});
