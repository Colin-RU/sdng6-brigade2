// Server-only FCM HTTP v1. No Firebase credentials or registration tokens leave this module/API.
const encoder=new TextEncoder(),SCOPE='https://www.googleapis.com/auth/firebase.messaging',OAUTH_URL='https://oauth2.googleapis.com/token';
const tokenCache=new Map();
function b64(bytes){let value='';for(const byte of new Uint8Array(bytes))value+=String.fromCharCode(byte);return btoa(value).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function configValue(env){
  let c=env.FCM_SERVICE_ACCOUNT;if(typeof c==='string'){try{c=JSON.parse(c);}catch{return null;}}
  if(!c||c.enabled===false||typeof c.project_id!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(c.project_id)||typeof c.client_email!=='string'||!/^[a-zA-Z0-9._-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(c.client_email)||typeof c.private_key!=='string'||c.private_key.length>16384||!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\s*$/.test(c.private_key)||('private_key_id'in c&&(typeof c.private_key_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(c.private_key_id))))return null;
  return c;
}
export const fcmConfigured=env=>configValue(env)!==null;
export async function serviceAccountAssertion(config,time=Math.floor(Date.now()/1000)){
  const c=configValue({FCM_SERVICE_ACCOUNT:config});if(!c)throw Error('FCM configuration invalid');
  const der=Uint8Array.from(atob(c.private_key.replace(/-----[^-]+-----|\s/g,'')),ch=>ch.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const header=b64(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT',...(c.private_key_id?{kid:c.private_key_id}:{})}))),claims=b64(encoder.encode(JSON.stringify({iss:c.client_email,scope:SCOPE,aud:OAUTH_URL,iat:time,exp:time+3600}))),input=header+'.'+claims;
  return input+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(input)));
}
async function boundedJson(response){
  if(Number(response.headers.get('Content-Length')??0)>32768)throw Object.assign(Error('Provider response too large'),{permanent:true});
  const reader=response.body?.getReader();if(!reader)return null;const chunks=[];let length=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>32768){await reader.cancel();throw Object.assign(Error('Provider response too large'),{permanent:true});}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
}
async function providerRequest(fetcher,url,options){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetcher(url,{...options,redirect:'error',signal:controller.signal});return {status:response.status,ok:response.ok,data:await boundedJson(response)};}catch(error){if(!error.permanent)error.providerRetryable=true;throw error;}finally{clearTimeout(timer);}
}
async function cacheEntry(c){
  const hash=b64(await crypto.subtle.digest('SHA-256',encoder.encode(c.project_id+'\n'+c.client_email+'\n'+c.private_key)));
  if(!tokenCache.has(hash)){if(tokenCache.size>=4)tokenCache.delete(tokenCache.keys().next().value);tokenCache.set(hash,{token:null,until:0,pending:null});}
  return tokenCache.get(hash);
}
async function accessToken(c,fetcher,entry){
  if(entry.token&&entry.until>Date.now())return entry.token;
  if(!entry.pending)entry.pending=(async()=>{
    const assertion=await serviceAccountAssertion(c),body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion});
    const response=await providerRequest(fetcher,OAUTH_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()}),data=response.data;
    if(!response.ok||typeof data?.access_token!=='string'||data.access_token.length>8192||!/^[\x21-\x7e]{16,}$/.test(data.access_token)||!Number.isFinite(data.expires_in)||data.expires_in<120)throw Object.assign(Error('FCM authorization unavailable'),{providerRetryable:response.status===429||response.status>=500});
    entry.token=data.access_token;entry.until=Date.now()+(Math.min(data.expires_in,3600)-60)*1000;return entry.token;
  })().finally(()=>{entry.pending=null;});
  return entry.pending;
}
function opaqueData(payload){
  if(!payload||typeof payload.notificationId!=='string'||!/^[A-Za-z0-9-]{1,64}$/.test(payload.notificationId)||!['chat','comment','sampling-round'].includes(payload.type))throw Error('FCM payload invalid');
  // Never include title, body, object name, author or chat text in the FCM transport.
  return {notificationId:payload.notificationId,type:payload.type};
}
export async function sendFcm(env,userIds,payload){
  const result={enabled:false,sent:0,failed:0,expired:0,retryable:0},c=configValue(env);if(!c)return result;result.enabled=true;
  const data=opaqueData(payload),users=[...new Set(userIds)];if(users.length>20||users.some(id=>typeof id!=='string'||!/^[A-Za-z0-9-]{1,64}$/.test(id)))throw Error('FCM recipients invalid');if(!users.length)return result;
  // Persisted notification ownership and an active session are both required at delivery.
  const rows=(await env.DB.prepare(`SELECT d.id,d.user_id,d.session_hash,d.token_hash,d.token FROM native_push_tokens d JOIN sessions s ON s.token_hash=d.session_hash AND s.user_id=d.user_id JOIN notifications n ON n.recipient_id=d.user_id AND n.id=? AND n.type=? WHERE d.user_id IN (${users.map(()=>'?').join(',')}) AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 200`).bind(data.notificationId,data.type,...users,Date.now()).all()).results??[];
  if(!rows.length)return result;
  const fetcher=env.FCM_FETCH??fetch,entry=await cacheEntry(c);let bearer;
  try{bearer=await accessToken(c,fetcher,entry);}catch(error){result.failed=rows.length;if(error.providerRetryable)result.retryable=rows.length;return result;}
  const endpoint=`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.project_id)}/messages:send`;
  for(let offset=0;offset<rows.length;offset+=5)await Promise.all(rows.slice(offset,offset+5).map(async row=>{
    try{
      const response=await providerRequest(fetcher,endpoint,{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify({message:{token:row.token,android:{priority:'HIGH',ttl:'86400s'},data}})});
      if(response.ok){result.sent++;return;}
      const unregistered=response.status===404&&response.data?.error?.details?.some(detail=>detail['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError'&&detail.errorCode==='UNREGISTERED');
      if(unregistered){
        // A delayed provider response cannot delete a freshly rotated or rebound token.
        await env.DB.prepare('DELETE FROM native_push_tokens WHERE id=? AND user_id=? AND session_hash=? AND token_hash=?').bind(row.id,row.user_id,row.session_hash,row.token_hash).run();result.expired++;
      }else{if(response.status===401){entry.token=null;entry.until=0;}if(response.status===429||response.status>=500)result.retryable++;result.failed++;}
    }catch(error){result.failed++;if(error.providerRetryable)result.retryable++;}
  }));
  return result;
}
