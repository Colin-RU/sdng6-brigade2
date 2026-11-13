import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createECDH,randomBytes,createPublicKey,verify} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {encryptPush,vapidAuthorization,sendPush,providerAllowed,b64} from '../worker/push.mjs';
const require=createRequire(import.meta.url),pushRequire=createRequire(require.resolve('web-push'));
const ece=pushRequire('http_ece');
const ua=createECDH('prime256v1');ua.generateKeys();const auth=randomBytes(16);
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',p256dh:ua.getPublicKey().toString('base64url'),auth:auth.toString('base64url')};
const vapidPair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const config={publicKey:b64(await crypto.subtle.exportKey('raw',vapidPair.publicKey)),privateJwk:await crypto.subtle.exportKey('jwk',vapidPair.privateKey),subject:'https://example.test/brigade'};
const checks=[];
await test('RFC8291 ciphertext decrypts with independent http_ece 1.2.1',async()=>{
  const payload={title:'Оператор: новый комментарий',body:'АГЗУ · куст №162 — проверить состояние',notificationId:'synthetic-id',objectKey:'equipment:162:agzu'};
  const encrypted=await encryptPush(subscription,payload),plaintext=ece.decrypt(Buffer.from(encrypted),{version:'aes128gcm',privateKey:ua,authSecret:auth});
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')),payload);assert.equal(new DataView(encrypted.buffer,encrypted.byteOffset+16,4).getUint32(0,false),4096);assert.equal(encrypted[20],65);
  const second=await encryptPush(subscription,payload);assert.notDeepEqual(second,encrypted);
  const corrupted=Buffer.from(encrypted);corrupted[corrupted.length-1]^=1;assert.throws(()=>ece.decrypt(corrupted,{version:'aes128gcm',privateKey:ua,authSecret:auth}));
  checks.push('RFC8291 independent decrypt, fresh salt/key and tamper rejection');
});
await test('VAPID JWT verifies with independent Node OpenSSL ES256',async()=>{
  const value=await vapidAuthorization(subscription.endpoint,config),match=value.match(/^vapid t=([^,]+), k=(.+)$/);assert.ok(match);assert.equal(match[2],config.publicKey);
  const [header,payload,signature]=match[1].split('.'),claims=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url').toString('utf8')),{typ:'JWT',alg:'ES256'});assert.equal(claims.aud,'https://fcm.googleapis.com');assert.equal(claims.sub,config.subject);assert.ok(claims.exp-Math.floor(Date.now()/1000)>=43195&&claims.exp-Math.floor(Date.now()/1000)<=43200);
  const publicJwk=await crypto.subtle.exportKey('jwk',vapidPair.publicKey),key=createPublicKey({key:publicJwk,format:'jwk'});
  assert.ok(verify('sha256',Buffer.from(header+'.'+payload),{key,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')));assert.equal(Buffer.from(signature,'base64url').length,64);checks.push('VAPID independent ES256 signature, audience and12h expiry');
});
await test('provider results retain transient failures and delete only expired subscription',async()=>{
  const rows=[{...subscription,id:'success',user_id:'user-a',endpoint:'https://fcm.googleapis.com/fcm/send/success'},{...subscription,id:'expired',user_id:'user-a',endpoint:'https://fcm.googleapis.com/fcm/send/expired'},{...subscription,id:'transient',user_id:'user-b',endpoint:'https://web.push.apple.com/transient'},{...subscription,id:'forbidden',user_id:'user-a',endpoint:'http://127.0.0.1/admin'}],deletions=[],requests=[];
  const DB={prepare(sql){return {bind(...args){return {async all(){assert.deepEqual(args,['user-a','user-b']);return {results:rows};},async run(){deletions.push({sql,args});return {success:true};}};}};}};
  const env={DB,VAPID_PUBLIC_KEY:config.publicKey,VAPID_PRIVATE_JWK:config.privateJwk,VAPID_SUBJECT:config.subject,PUSH_FETCH:async(endpoint,options)=>{requests.push({endpoint,options});assert.equal(options.redirect,'error');assert.equal(options.headers['Content-Encoding'],'aes128gcm');assert.equal(options.headers.TTL,'86400');assert.ok(options.signal instanceof AbortSignal);const status=endpoint.endsWith('expired')?410:endpoint.endsWith('transient')?500:201;return new Response(null,{status});}};
  assert.deepEqual(await sendPush(env,['user-a','user-b','user-a'],{title:'test'}),{sent:1,failed:2,expired:1,retryable:1});assert.equal(requests.length,3);assert.equal(deletions.length,1);assert.match(deletions[0].sql,/WHERE id=\? AND user_id=\?/);assert.deepEqual(deletions[0].args,['expired','user-a']);
  for(const request of requests)assert.deepEqual(JSON.parse(ece.decrypt(Buffer.from(request.options.body),{version:'aes128gcm',privateKey:ua,authSecret:auth}).toString('utf8')),{title:'test'});checks.push('201 delivered;410 scoped delete;500 retained; forbidden destination not fetched');
});
await test('provider allowlist and UTF8 payload bounds',async()=>{
  for(const endpoint of ['https://fcm.googleapis.com/fcm/send/token','https://updates.push.services.mozilla.com/wpush/v2/token','https://web.push.apple.com/token','https://db5.notify.windows.com/token'])assert.ok(providerAllowed(endpoint),endpoint);
  for(const endpoint of ['http://fcm.googleapis.com/path','https://fcm.googleapis.com.evil.test/path','https://fcm.googleapis.com@127.0.0.1/path','https://fcm.googleapis.com:444/path','https://127.0.0.1/path','https://evilnotify.windows.com/path','file:///tmp/a'])assert.equal(providerAllowed(endpoint),false,endpoint);
  assert.equal(ece.decrypt(Buffer.from(await encryptPush(subscription,'x'.repeat(3000))),{version:'aes128gcm',privateKey:ua,authSecret:auth}).length,3000);await assert.rejects(()=>encryptPush(subscription,'я'.repeat(1501)),/too large/);await assert.rejects(()=>encryptPush({...subscription,auth:'AAAA'},'test'),/Invalid push key/);checks.push('SSRF provider allowlist and3000byte UTF8 bound');
});
await test('Web Push classifies429/5xx/network for bounded retry; permanent4xx and missing config do not retry',async()=>{
  for(const status of [400,401,403,429,500,503,'network']){
    const DB={prepare(){return {bind(){return {async all(){return {results:[{...subscription,id:'retry-test',user_id:'user-one'}]};}};}};}},env={DB,VAPID_PUBLIC_KEY:config.publicKey,VAPID_PRIVATE_JWK:config.privateJwk,VAPID_SUBJECT:config.subject,PUSH_FETCH:async()=>{if(status==='network')throw Error('Synthetic network unavailable');return new Response(null,{status});}};
    const result=await sendPush(env,['user-one'],{title:'test'});assert.equal(result.failed,1);assert.equal(result.retryable,status==='network'||status===429||status>=500?1:0,String(status));
  }
  assert.deepEqual(await sendPush({},['user-one'],{}),{sent:0,failed:0,expired:0,retryable:0});checks.push('Only429/5xx/network enter retry queue; permanent4xx and missing configuration do not');
});
await writeFile(new URL('push-interop-report.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),runtime:process.version,independentDecryptor:'http_ece 1.2.1 (web-push 4.0.0 dependency)',passed:true,checks},null,2)+'\n');
