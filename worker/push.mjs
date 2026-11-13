// RFC 8291 aes128gcm and RFC 8292 VAPID. Private keys only arrive from server config.
const utf8=new TextEncoder();
const bytes=value=>value instanceof Uint8Array?value:new Uint8Array(value);
const concat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const p of parts){out.set(p,offset);offset+=p.length;}return out;};
export const b64=value=>{let raw='';for(const n of bytes(value))raw+=String.fromCharCode(n);return btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');};
export const unb64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
async function hmac(key,data){const k=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,data));}
async function expand(key,info,length){return(await hmac(key,concat(info,Uint8Array.of(1)))).slice(0,length);}
export function providerAllowed(endpoint){try{const u=new URL(endpoint),h=u.hostname;return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(h==='fcm.googleapis.com'||h==='updates.push.services.mozilla.com'||h.endsWith('.push.services.mozilla.com')||h==='web.push.apple.com'||h.endsWith('.push.apple.com')||h.endsWith('.notify.windows.com'));}catch{return false;}}
export async function encryptPush(subscription,payload){
 const receiver=unb64(subscription.p256dh||subscription.keys?.p256dh),auth=unb64(subscription.auth||subscription.keys?.auth);
 if(receiver.length!==65||receiver[0]!==4||auth.length!==16)throw Error('Invalid push key');
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const sender=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 const receiverKey=await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:receiverKey},pair.privateKey,256));
 const secret=await hmac(auth,shared),ikm=await expand(secret,concat(utf8.encode('WebPush: info\0'),receiver,sender),32);
 const salt=crypto.getRandomValues(new Uint8Array(16)),prk=await hmac(salt,ikm);
 const cek=await expand(prk,utf8.encode('Content-Encoding: aes128gcm\0'),16),nonce=await expand(prk,utf8.encode('Content-Encoding: nonce\0'),12);
 const message=utf8.encode(typeof payload==='string'?payload:JSON.stringify(payload));if(message.length>3000)throw Error('Push payload too large');
 const key=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},key,concat(message,Uint8Array.of(2))));
 const record=new Uint8Array(4);new DataView(record.buffer).setUint32(0,4096,false);
 return concat(salt,record,Uint8Array.of(sender.length),sender,ciphertext);
}
export async function vapidAuthorization(endpoint,config){
 const header=b64(utf8.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=b64(utf8.encode(JSON.stringify({aud:new URL(endpoint).origin,exp:Math.floor(Date.now()/1000)+43200,sub:config.subject})));
 const signing=`${header}.${claims}`;
 const key=await crypto.subtle.importKey('jwk',config.privateJwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
 const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,utf8.encode(signing)));
 if(signature.length!==64)throw Error('Invalid VAPID signature');
 return `vapid t=${signing}.${b64(signature)}, k=${config.publicKey}`;
}
export async function sendPush(env,userIds,payload){
 const config={publicKey:env.VAPID_PUBLIC_KEY,privateJwk:env.VAPID_PRIVATE_JWK,subject:env.VAPID_SUBJECT};
 const result={sent:0,failed:0,expired:0,retryable:0};if(!config.publicKey||!config.privateJwk||!config.subject)return result;
 const ids=[...new Set(userIds)].filter(x=>typeof x==='string').slice(0,20);if(!ids.length)return result;
 const rows=(await env.DB.prepare(`SELECT id,user_id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id IN (${ids.map(()=>'?').join(',')}) AND visible_until<=atlas_now_ms()`).bind(...ids).all()).results||[];
 const fetcher=env.PUSH_FETCH||fetch;
 for(let offset=0;offset<rows.length;offset+=5)await Promise.all(rows.slice(offset,offset+5).map(async row=>{
  if(!providerAllowed(row.endpoint)){result.failed++;return;}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  let fetching=false;
  try{
   const body=await encryptPush(row,payload),authorization=await vapidAuthorization(row.endpoint,config);
   fetching=true;const response=await fetcher(row.endpoint,{method:'POST',headers:{Authorization:authorization,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'86400',Urgency:'normal'},body,redirect:'error',signal:controller.signal});
   await response.body?.cancel();
   if(response.status===404||response.status===410){await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=? AND user_id=?').bind(row.id,row.user_id).run();result.expired++;}
   else if(response.ok)result.sent++;else{result.failed++;if(response.status===429||response.status>=500)result.retryable++;}
  }catch{result.failed++;if(fetching)result.retryable++;}finally{clearTimeout(timeout);}
 }));
 return result;
}
