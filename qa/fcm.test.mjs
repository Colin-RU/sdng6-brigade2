import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {serviceAccountAssertion,fcmConfigured,sendFcm} from '../worker/fcm.mjs';
import {postgresSql} from '../worker/adapters/supabase.mjs';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),pem=privateKey.export({type:'pkcs8',format:'pem'});
const account=n=>({project_id:'brigade-fcm-qa-'+n,client_email:'fcm-test@brigade-test.iam.gserviceaccount.com',private_key:pem,private_key_id:'synthetic-key-id',token_uri:'https://untrusted.example/token'});
const checks=[];
function database(rows,expectedType='chat'){
  const deletions=[];
  return {deletions,prepare(sql){return {bind(...args){return {async all(){assert.match(sql,/JOIN sessions/);assert.match(sql,/JOIN notifications/);assert.match(sql,/s.revoked_at IS NULL AND s.expires_at>\?/);assert.match(sql,/LIMIT 200/);assert.equal(args[0],'opaque-notification-id');assert.equal(args[1],expectedType);return {results:rows.map(r=>({...r}))};},async run(){deletions.push({sql,args});const [id,user,session,hash]=args,index=rows.findIndex(r=>r.id===id&&r.user_id===user&&r.session_hash===session&&r.token_hash===hash);if(index>=0)rows.splice(index,1);return {success:true,meta:{changes:index>=0?1:0}};}};}};}};
}
const row=(id,user='user-one')=>({id,user_id:user,session_hash:'session-'+id,token_hash:'hash-'+id,token:'opaque-registration-token-'+id});
const event={notificationId:'opaque-notification-id',type:'chat',title:'Private author name',body:'Private message',objectKey:'well:162:3563'};
await test('FCM OAuth RS256 assertion verifies independently with Node OpenSSL',async()=>{
  const c=account('signature'),time=Math.floor(Date.now()/1000),jwt=await serviceAccountAssertion(c,time),[head,payload,signature]=jwt.split('.'),header=JSON.parse(Buffer.from(head,'base64url')),claims=JSON.parse(Buffer.from(payload,'base64url'));
  assert.deepEqual(header,{alg:'RS256',typ:'JWT',kid:c.private_key_id});assert.deepEqual(claims,{iss:c.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:time,exp:time+3600});
  assert.equal(verify('RSA-SHA256',Buffer.from(head+'.'+payload),publicKey,Buffer.from(signature,'base64url')),true);
  assert.equal(verify('RSA-SHA256',Buffer.from(head+'.'+payload+'x'),publicKey,Buffer.from(signature,'base64url')),false);checks.push('Independent RS256 signature, fixed OAuth audience, messaging scope and1h lifetime');
});
await test('FCM uses cached OAuth, data-only HIGH delivery and fixed destinations',async()=>{
  const rows=[row('a'),row('b')],DB=database(rows),calls=[],c=account('cache');let oauth=0;
  const env={DB,FCM_SERVICE_ACCOUNT:c,FCM_FETCH:async(url,options)=>{
    calls.push({url,options});assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    if(url==='https://oauth2.googleapis.com/token'){oauth++;const form=new URLSearchParams(options.body);assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');const jwt=form.get('assertion').split('.');assert.equal(verify('RSA-SHA256',Buffer.from(jwt[0]+'.'+jwt[1]),publicKey,Buffer.from(jwt[2],'base64url')),true);return Response.json({access_token:'synthetic-oauth-access-token',expires_in:3600,token_type:'Bearer'});}
    assert.equal(url,'https://fcm.googleapis.com/v1/projects/'+c.project_id+'/messages:send');assert.equal(options.headers.Authorization,'Bearer synthetic-oauth-access-token');const message=JSON.parse(options.body).message;assert.deepEqual(message.data,{notificationId:event.notificationId,type:'chat'});assert.deepEqual(message.android,{priority:'HIGH',ttl:'86400s'});assert.equal(message.notification,undefined);assert.ok(!options.body.includes(event.body));return Response.json({name:'projects/test/messages/id'});
  }};
  const results=await Promise.all([sendFcm(env,['user-one'],event),sendFcm(env,['user-one'],event)]);assert.deepEqual(results,[{enabled:true,sent:2,failed:0,expired:0,retryable:0},{enabled:true,sent:2,failed:0,expired:0,retryable:0}]);assert.equal(oauth,1,'concurrent OAuth exchange is shared');assert.equal(calls.length,5);checks.push('One cached/in-flight OAuth exchange, fixed provider hosts, no text in HIGH data payload');
});
await test('FCM UNREGISTERED deletes exact binding; provider failures and rotated token survive',async()=>{
  const rows=[row('ok'),row('expired'),row('transient'),row('rotated'),row('invalid')],DB=database(rows);let active=0,peak=0;
  const env={DB,FCM_SERVICE_ACCOUNT:account('errors'),FCM_FETCH:async(url,options)=>{
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-error-access-token',expires_in:3600});
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    const token=JSON.parse(options.body).message.token,id=token.split('-').at(-1);
    if(id==='ok')return Response.json({name:'delivered'});
    if(id==='transient')return Response.json({error:{status:'INTERNAL'}},{status:500});
    if(id==='invalid')return Response.json({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'INVALID_ARGUMENT'}]}},{status:400});
    if(id==='rotated')rows.find(r=>r.id==='rotated').token_hash='new-rotated-hash';
    return Response.json({error:{details:[{'@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',errorCode:'UNREGISTERED'}]}},{status:404});
  }};
  assert.deepEqual(await sendFcm(env,['user-one'],event),{enabled:true,sent:1,failed:2,expired:2,retryable:1});assert.ok(peak<=5);assert.equal(DB.deletions.length,2);assert.ok(DB.deletions.every(d=>/WHERE id=\? AND user_id=\? AND session_hash=\? AND token_hash=\?/.test(d.sql)));assert.deepEqual(rows.map(r=>r.id).sort(),['invalid','ok','rotated','transient']);checks.push('UNREGISTERED exact-token cleanup; late response cannot delete rotation;400/500 retained; parallelism≤5');
});
await test('FCM disables honestly without credentials and rejects unsafe inputs/provider responses',async()=>{
  let fetched=0;const DB=database([row('one')]),fetcher=async()=>{fetched++;return Response.json({access_token:'x'.repeat(40000),expires_in:3600});};
  for(const config of [null,{}, {...account('bad-project'),project_id:'../../evil'}, {...account('bad-email'),client_email:'user@evil.example'}, {...account('disabled'),enabled:false}]){assert.equal(fcmConfigured({FCM_SERVICE_ACCOUNT:config}),false);assert.deepEqual(await sendFcm({DB,FCM_SERVICE_ACCOUNT:config,FCM_FETCH:fetcher},['user-one'],event),{enabled:false,sent:0,failed:0,expired:0,retryable:0});}
  assert.equal(fetched,0);
  const env={DB,FCM_SERVICE_ACCOUNT:account('bounds'),FCM_FETCH:fetcher};assert.equal(fcmConfigured(env),true);
  await assert.rejects(()=>sendFcm(env,['user-one'],{...event,notificationId:'x'.repeat(65)}),/payload invalid/);await assert.rejects(()=>sendFcm(env,['user-one'],{...event,type:'unknown'}),/payload invalid/);await assert.rejects(()=>sendFcm(env,Array.from({length:21},(_,i)=>'user-'+i),event),/recipients invalid/);
  assert.deepEqual(await sendFcm(env,['user-one'],event),{enabled:true,sent:0,failed:1,expired:0,retryable:0});assert.equal(fetched,1);assert.equal(DB.deletions.length,0);checks.push('Missing config disabled; recipient/payload bounds and oversized OAuth response reject without deleting devices');
});
await test('FCM migration and SQL adapter keep token storage private with hard device slots',async()=>{
  const sql=await readFile(new URL('fcm-schema-review.sql',import.meta.url),'utf8');
  for(const clause of ['ENABLE ROW LEVEL SECURITY','REVOKE ALL ON brigade.native_push_tokens FROM PUBLIC, anon, authenticated','GRANT ALL ON brigade.native_push_tokens TO service_role','ON DELETE CASCADE','device_slot BETWEEN 1 AND 10','(user_id,device_slot)','(token_hash)','(installation_hash)'])assert.ok(sql.includes(clause),clause);
  assert.match(postgresSql('SELECT d.id FROM native_push_tokens d JOIN sessions s ON s.token_hash=d.session_hash'),/FROM brigade\."native_push_tokens" d JOIN brigade\."sessions"/);
  checks.push('Private RLS/service-only table, unique token/install and hard10 slots, session cascade and adapter qualification');
});
await test('FCM sender on SQLite excludes expired/revoked sessions and another notification recipient',async()=>{
  const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON;');
  for(const name of ['0000_brigade','0001_shift_times','0002_equipment_absent','0003_partial_sampling','0004_native_fcm_devices'])raw.exec(await readFile(new URL('sqlite-migrations/'+name+'.sql',import.meta.url),'utf8'));
  for(const user of ['user-a','user-b'])raw.prepare('INSERT INTO profiles(id,login,password_hash,nickname,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(user,user,'synthetic-hash',user,'operator',1,1);
  const states=[['active','user-a',Date.now()+86400000,null],['expired','user-a',1,null],['revoked','user-a',Date.now()+86400000,1],['other-recipient','user-b',Date.now()+86400000,null]];
  for(const [i,[id,user,expiry,revoked]]of states.entries()){
    raw.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?)').run(id,user,1,expiry,revoked);
    raw.prepare('INSERT INTO native_push_tokens(id,installation_hash,secret_hash,user_id,session_hash,token_hash,token,device_slot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,'secret',user,id,id,'synthetic-registration-token-'+id,i+1,1,1);
  }
  raw.prepare('INSERT INTO notifications(id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.notificationId,'user-a','user-b','chat','chat','Чат','message','message','private text',1);
  const DB={prepare(sql){return {bind(...args){return {async all(){return {results:raw.prepare(sql).all(...args)};},async run(){return raw.prepare(sql).run(...args);}};}};}},sent=[];
  const env={DB,FCM_SERVICE_ACCOUNT:account('session-filter'),FCM_FETCH:async(url,options)=>{if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-sqlite-access-token',expires_in:3600});sent.push(JSON.parse(options.body).message.token);return Response.json({name:'delivered'});}};
  assert.deepEqual(await sendFcm(env,['user-a','user-b'],event),{enabled:true,sent:1,failed:0,expired:0,retryable:0});assert.deepEqual(sent,['synthetic-registration-token-active']);assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,4);raw.close();checks.push('Real SQLite joins deliver only the notification recipient with a current unrevoked session');
});
await test('FCM classifies only429/5xx/network as retryable and accepts opaque sampling-round transport',async()=>{
  for(const status of [400,401,403,404,429,500,503,'network']){
    const env={DB:database([row('classify')]),FCM_SERVICE_ACCOUNT:account('http-'+status),FCM_FETCH:async(url)=>{if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-classification-token',expires_in:3600});if(status==='network')throw Error('Synthetic network unavailable');return Response.json({error:{status:'Synthetic'}},{status});}};
    const result=await sendFcm(env,['user-one'],event);assert.equal(result.failed,1);assert.equal(result.retryable,status==='network'||status===429||status>=500?1:0,String(status));assert.equal(env.DB.deletions.length,0);
  }
  let body;const env={DB:database([row('round')],'sampling-round'),FCM_SERVICE_ACCOUNT:account('round-type'),FCM_FETCH:async(url,options)=>{if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-round-access-token',expires_in:3600});body=JSON.parse(options.body);return Response.json({name:'ok'});}};
  assert.equal((await sendFcm(env,['user-one'],{...event,type:'sampling-round'})).sent,1);assert.deepEqual(body.message.data,{notificationId:event.notificationId,type:'sampling-round'});assert.equal(body.message.notification,undefined);checks.push('429/5xx/network retryable; permanent4xx retained without retry; sampling-round remains DATA only');
});
await writeFile(new URL('fcm-report.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),runtime:process.version,passed:true,productionCalls:false,checks},null,2)+'\n');
