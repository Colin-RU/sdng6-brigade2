import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {handleApi} from '../worker/api/index.mjs';
import {sha256,base64url} from '../worker/api/core.mjs';
import {passwordHash} from '../worker/api/auth.mjs';
import {samplingPeriod} from '../worker/api/sampling-periods.mjs';
import {registry,padIds,samplingPadIds,productionWellIds} from '../worker/registry.mjs';
const root=new URL('../',import.meta.url);
class Statement {
  constructor(db,sql,args=[]){Object.assign(this,{db,sql,args});}
  bind(...args){return new Statement(this.db,this.sql,args);}
  execute(){const stmt=this.db.prepare(this.sql);if(stmt.columns().length){const results=stmt.all(...this.args);return {success:true,results,meta:{changes:results.length}};}const info=stmt.run(...this.args);return {success:true,results:[],meta:{changes:Number(info.changes),last_row_id:Number(info.lastInsertRowid)}};}
  async first(column){const row=this.execute().results[0]??null;return column&&row?row[column]:row;}
  async all(){return this.execute();}
  async run(){return this.execute();}
}
class D1 {
  constructor(sql){this.raw=new DatabaseSync(':memory:');this.clock=()=>Date.now();this.raw.function('atlas_now_ms',()=>this.clock());this.raw.exec('PRAGMA foreign_keys=ON;');this.raw.exec(sql);}
  prepare(sql){return new Statement(this.raw,sql);}
  async batch(statements){this.raw.exec('BEGIN');try{const results=statements.map(s=>s.execute());this.raw.exec('COMMIT');return results;}catch(error){this.raw.exec('ROLLBACK');throw error;}}
}
class R2 {
  store=new Map();
  async put(key,bytes,metadata){this.store.set(key,{bytes:Uint8Array.from(bytes),metadata});}
  async get(key){const item=this.store.get(key);return item?{body:item.bytes,...item.metadata}:null;}
  async delete(key){this.store.delete(key);}
}
const migrationFiles=(await readdir(new URL('qa/sqlite-migrations/',root))).filter(f=>f.endsWith('.sql')).sort();
const schema=(await Promise.all(migrationFiles.map(f=>readFile(new URL('qa/sqlite-migrations/'+f,root),'utf8')))).join('\n');
assert.ok(schema.includes('CREATE TABLE'),'generated migrations are required');
const createEnv=()=>({DB:new D1(schema),BUCKET:new R2()});
let ip=0;
function client(env,token=null,host='https://atlas.example'){
  const address=`192.0.2.${++ip}`;
  return async(path,method='GET',body=null,headers={},hooks={})=>{
    if(typeof headers==='function')headers=await headers();
    if(method==='PUT'&&path.startsWith('/samples/')&&body&&typeof body==='object'&&!Object.hasOwn(body,'periodKey'))body={...body,periodKey:samplingPeriod(env.DB.clock()).key};
    const requestHeaders=new Headers(headers);requestHeaders.set('CF-Connecting-IP',address);if(token)requestHeaders.set('Authorization','Bearer '+token);
    let payload=body;if(body!==null&&!(body instanceof FormData)&&!(body instanceof Uint8Array)&&typeof body!=='string'){requestHeaders.set('Content-Type','application/json');payload=JSON.stringify(body);}
    const tasks=[],response=await handleApi(new Request(host+'/api/v1'+path,{method,headers:requestHeaders,...(payload!==null?{body:payload}:{})}),env,{waitUntil:p=>tasks.push(p)},hooks);await Promise.all(tasks);const data=response?.headers.get('Content-Type')?.includes('application/json')?await response.clone().json():null;return {response,status:response?.status,data};
  };
}
async function schedulerHeaders(secret,time,method='POST',path='/internal/sampling-round'){
  const timestamp=String(time),encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return {'X-Atlas-Scheduler-Time':timestamp,'X-Atlas-Scheduler':base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(method+'\n'+path+'\n'+timestamp))))};
}
async function register(env,login='operator.one',extra={}){const result=await client(env)('/auth/register','POST',{login,password:'long password 123',nickname:login,position:'operator',grade:4,...extra});assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
function imageForm(clientId='image-request-one',bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cK1cAAAAASUVORK5CYII=','base64'),type='image/png'){
  const form=new FormData();form.set('file',new Blob([bytes],{type}),'photo.png');if(clientId)form.set('clientId',clientId);return form;
}
const checks=[];
await test('API on real SQLite, WebCrypto and in-memory R2',async t=>{
  await t.test('protected reads and clean routing',async()=>{
    const env=createEnv(),call=client(env);assert.equal((await call('/health')).status,200);
    for(const path of ['/profiles','/me','/chat/messages','/objects/pad%3A162/notes','/samples','/objects/pad%3A162/status','/shifts?from=2026-11-01&to=2026-11-30','/notifications','/notifications/unread-count','/media/not-found','/push/public-key']){const r=await call(path);assert.equal(r.status,401,path);assert.equal(r.response.headers.get('Cache-Control'),'no-store');}
    assert.equal(await handleApi(new Request('https://atlas.example/index.html'),env),null);checks.push('all shared reads authenticated');
  });
  await t.test('credentials, session expiry, no plaintext, revocation',async()=>{
    const env=createEnv(),session=await register(env),call=client(env,session.token),stored=env.DB.raw.prepare('SELECT * FROM profiles').get();
    assert.match(stored.password_hash,/^pbkdf2-sha256\$100000\$/);assert.ok(!JSON.stringify(stored).includes('long password 123'));assert.equal(env.DB.raw.prepare('SELECT token_hash FROM sessions').get().token_hash,await sha256(session.token));assert.ok(!JSON.stringify(session.user).includes('password'));
    assert.equal((await call('/me')).data.user.id,session.user.id);
    const login=await client(env)('/auth/login','POST',{login:'OPERATOR.ONE',password:'long password 123',remember:false});assert.equal(login.status,200);assert.ok(Math.abs(Date.parse(login.data.expiresAt)-Date.now()-86400000)<3000);
    assert.ok(Math.abs(Date.parse(session.expiresAt)-Date.now()-30*86400000)<3000);
    const wrong=await client(env)('/auth/login','POST',{login:'operator.one',password:'wrong password'}),unknown=await client(env)('/auth/login','POST',{login:'unknown.user',password:'wrong password'});assert.equal(wrong.status,401);assert.deepEqual(wrong.data,unknown.data);
    await call('/auth/logout','POST');assert.equal((await call('/me')).status,401);assert.equal((await client(env,login.data.token)('/me')).status,200);
    env.DB.raw.prepare('UPDATE sessions SET expires_at=1').run();assert.equal((await client(env,login.data.token)('/me')).status,401);checks.push('password hashes and 30d/24h revoked/expired sessions');
  });
  await t.test('strict origins and input rejection',async()=>{
    const env=createEnv(),session=await register(env),call=client(env,session.token);
    for(const origin of ['https://colin-ru.github.io','https://appassets.androidplatform.net','https://atlas.example','http://localhost:5511']){const r=await call('/me','GET',null,{Origin:origin});assert.equal(r.status,200);assert.equal(r.response.headers.get('Access-Control-Allow-Origin'),origin);}
    const denied=await call('/me','GET',null,{Origin:'https://evil.example'});assert.equal(denied.status,403);assert.equal(denied.response.headers.get('Access-Control-Allow-Origin'),null);
    assert.equal((await call('/me','PATCH',{nickname:'Changed',admin:true})).status,400);
    assert.equal((await call('/objects/well%3A162%3A999999/status')).status,400);assert.equal((await call('/objects/equipment%3A162%3Ainvented/status')).status,400);
    assert.equal((await call('/objects/well%3A%D0%9E%D0%94%3A4205%D0%A0/status')).status,200);checks.push('origin allowlist and imported object registry');
  });
  await t.test('four-character passwords work; three rejected; existing long hashes stay compatible',async()=>{
    const env=createEnv(),call=client(env);
    const shortRegister=await call('/auth/register','POST',{login:'too.short',password:'123',nickname:'Short',position:'operator',grade:4});assert.equal(shortRegister.status,400);assert.equal(shortRegister.data.error.code,'invalid_password');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,0);
    const four=await register(env,'four.character',{password:'1234'});assert.ok(four.token);assert.match(env.DB.raw.prepare('SELECT password_hash FROM profiles WHERE id=?').get(four.user.id).password_hash,/^pbkdf2-sha256\$100000\$/);
    assert.equal((await call('/auth/login','POST',{login:'four.character',password:'1234'})).status,200);assert.equal((await call('/auth/login','POST',{login:'four.character',password:'123'})).status,400);assert.equal((await call('/auth/login','POST',{login:'four.character',password:'4321'})).status,401);
    const longPassword='L'.repeat(128),long=await register(env,'long.character',{password:longPassword});assert.ok(long.token);assert.equal((await call('/auth/login','POST',{login:'long.character',password:longPassword})).status,200);
    assert.equal((await call('/auth/register','POST',{login:'too.long',password:'L'.repeat(129),nickname:'Long',position:'operator'})).status,400);assert.equal((await call('/auth/login','POST',{login:'long.character',password:'L'.repeat(129)})).status,400);
    const legacyPassword='legacy long password 123',legacyHash=await passwordHash(legacyPassword,new Uint8Array(16).fill(7)),time=Date.now();env.DB.raw.prepare('INSERT INTO profiles (id,login,password_hash,nickname,position,grade,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),'legacy.hash',legacyHash,'Legacy','operator',4,time,time);
    assert.equal((await call('/auth/login','POST',{login:'legacy.hash',password:legacyPassword})).status,200);checks.push('4-character registration/login, 3-character and129-character rejection, unchanged legacy password hashing');
  });
  await t.test('R2 images, ownership, byte limit and idempotency',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const upload=await ca('/media','POST',imageForm());assert.equal(upload.status,201,JSON.stringify(upload.data));const id=upload.data.media.id;
    const repeat=await ca('/media','POST',imageForm());assert.equal(repeat.status,200);assert.equal(repeat.data.media.id,id);assert.equal(env.BUCKET.store.size,1);
    const changed=imageForm('image-request-one',new Uint8Array([255,216,255,0,0,0,0,0,0,0,0,0]),'image/jpeg');assert.equal((await ca('/media','POST',changed)).status,409);
    assert.equal((await ca('/media','POST',imageForm('image-bad-magic',new Uint8Array(32)))).status,415);
    assert.equal((await ca('/media','POST',imageForm('image-oversized',new Uint8Array(2097153)))).status,413);
    assert.equal((await cb('/chat/messages','POST',{clientId:'other-user-media',body:'x',mediaIds:[id]})).status,400);
    assert.equal((await cb('/me','PATCH',{avatarMediaId:id})).status,400);assert.equal((await ca('/me','PATCH',{avatarMediaId:id})).status,200);
    const read=await cb('/media/'+id);assert.equal(read.status,200);assert.equal(read.response.headers.get('Content-Type'),'image/png');assert.equal((await read.response.arrayBuffer()).byteLength,upload.data.media.size);checks.push('bounded image bytes, ownership and upload retry');
  });
  await t.test('chat paging, retry and owner-only edits',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const ids=[];for(let i=0;i<5;i++){const r=await ca('/chat/messages','POST',{clientId:'chat-test-'+i,body:'Message '+i});assert.equal(r.status,201);ids.push(r.data.item.id);}
    assert.equal((await ca('/chat/messages','POST',{clientId:'chat-test-0',body:'Message 0'})).data.duplicate,true);assert.equal((await ca('/chat/messages','POST',{clientId:'chat-test-0',body:'different'})).status,409);
    const latest=(await cb('/chat/messages?limit=2')).data;assert.deepEqual(latest.items.map(i=>i.body),['Message 3','Message 4']);assert.equal(latest.nextCursor,'4');
    const earlier=(await cb('/chat/messages?limit=2&before='+latest.nextCursor)).data;assert.deepEqual(earlier.items.map(i=>i.body),['Message 1','Message 2']);
    const newer=(await cb('/chat/messages?limit=2&after=2')).data;assert.deepEqual(newer.items.map(i=>i.body),['Message 2','Message 3']);
    assert.equal((await cb('/chat/messages/'+ids[0],'DELETE')).status,403);assert.equal((await ca('/chat/messages/'+ids[0],'PATCH',{body:'Edited',revision:1})).data.item.revision,2);assert.equal((await ca('/chat/messages/'+ids[0],'PATCH',{body:'stale',revision:1})).status,409);checks.push('chat pagination, idempotency and owner edits');
  });
  await t.test('ordinary chat notifies every other profile once with recipient-specific push and deep link',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),c=await register(env,'operator.three'),ca=client(env,a.token),cb=client(env,b.token),cc=client(env,c.token),push=[];
    const payload={clientId:'chat-broadcast-test',body:'Сообщение всей бригаде'},hooks={sendPush:async(...args)=>push.push(args)};
    const response=await ca('/chat/messages','POST',payload,{},hooks);assert.equal(response.status,201);const message=response.data.item;
    assert.equal((await ca('/notifications/unread-count')).data.count,0);assert.equal((await cb('/notifications/unread-count')).data.count,1);assert.equal((await cc('/notifications/unread-count')).data.count,1);assert.equal(push.length,2);
    const bn=(await cb('/notifications')).data.items[0],cn=(await cc('/notifications')).data.items[0];assert.notEqual(bn.id,cn.id);assert.match(bn.id,/^[a-f0-9]{64}$/);assert.equal(bn.type,'chat');assert.equal(bn.objectKey,'chat');assert.equal(bn.objectLabel,'Чат бригады');assert.equal(bn.noteId,message.id);assert.equal(bn.parentId,message.id);
    for(const call of push){const recipient=call[1][0],notification=recipient===b.user.id?bn:cn;assert.equal(call[2].notificationId,notification.id);assert.equal(call[2].type,'chat');assert.equal(call[2].noteId,message.id);assert.ok(call[2].title.includes(a.user.nickname));}
    assert.equal((await cb('/notifications/'+cn.id)).status,404);assert.equal((await cb('/chat/messages/'+bn.noteId)).data.item.id,message.id);
    assert.equal((await ca('/chat/messages','POST',payload,{},hooks)).data.duplicate,true);assert.equal(push.length,2);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM notifications').get().count,2);
    assert.equal((await ca('/chat/messages/'+message.id,'PATCH',{body:'Изменено',revision:1},{},hooks)).status,200);assert.equal(push.length,2);assert.equal((await ca('/chat/messages/'+message.id,'DELETE',null,{},hooks)).status,200);assert.equal(push.length,2);assert.equal((await cb('/chat/messages/'+message.id)).status,404);assert.equal((await cb('/notifications')).data.items.length,1);checks.push('ordinary chat persists one notification per other profile and sends distinct push deep links without retry/edit/delete duplicates');
  });
  await t.test('notification type filters paginate work behind chat and mark read only for recipient and type',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),c=await register(env,'operator.three'),ca=client(env,a.token),cb=client(env,b.token),cc=client(env,c.token);
    const parent=(await cb('/objects/pad%3A162/notes','POST',{clientId:'filter-parent-note',body:'Parent'})).data.item;
    for(let i=0;i<2;i++)assert.equal((await ca('/objects/pad%3A162/notes','POST',{clientId:'filter-reply-'+i,body:'Work '+i,parentId:parent.id})).status,201);
    for(let i=0;i<45;i++)assert.equal((await ca('/chat/messages','POST',{clientId:'filter-chat-'+i,body:'Chat '+i})).status,201);
    assert.equal((await cb('/notifications/unread-count')).data.count,47);assert.equal((await cc('/notifications/unread-count')).data.count,45);
    const work=(await cb('/notifications?type=comment&limit=1')).data;assert.equal(work.items.length,1);assert.equal(work.items[0].type,'comment');assert.ok(work.nextCursor);
    const older=(await cb('/notifications?type=comment&limit=1&before='+work.nextCursor)).data;assert.equal(older.items.length,1);assert.equal(older.items[0].type,'comment');assert.notEqual(older.items[0].id,work.items[0].id);assert.equal((await cc('/notifications?type=comment')).data.items.length,0);
    assert.equal((await cb('/notifications?type=chat&limit=2')).data.items.length,2);assert.equal((await cb('/notifications?type=all')).status,400);assert.equal((await cb('/notifications/read-all?type=unknown','POST')).status,400);
    assert.equal((await cb('/notifications/read-all?type=chat','POST')).status,200);assert.equal((await cb('/notifications/unread-count')).data.count,2);assert.equal((await cb('/notifications?type=chat&unread=1')).data.items.length,0);assert.equal((await cb('/notifications?type=comment&unread=1')).data.items.length,2);assert.equal((await cc('/notifications/unread-count')).data.count,45);
    await cb('/notifications/read-all?type=comment','POST');assert.equal((await cb('/notifications/unread-count')).data.count,0);assert.equal((await cc('/notifications/unread-count')).data.count,45);checks.push('typed notification pagination reaches work behind45 chat messages; typed read-all and global unread-count preserve recipient isolation');
  });
  await t.test('owner media deletion refuses all live reference types and retains failed storage cleanup',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const id=(await ca('/media','POST',imageForm('delete-image-test'))).data.media.id,path='/media/'+id;
    assert.equal((await client(env)(path,'DELETE')).status,401);assert.equal((await cb(path,'DELETE')).status,403);
    await ca('/me','PATCH',{avatarMediaId:id});assert.equal((await ca(path,'DELETE')).status,409);await ca('/me','PATCH',{avatarMediaId:null});
    const chat=(await ca('/chat/messages','POST',{clientId:'delete-image-chat',body:'Image',mediaIds:[id]})).data.item;assert.equal((await ca(path,'DELETE')).data.error.code,'media_in_use');await ca('/chat/messages/'+chat.id,'DELETE');
    const note=(await ca('/objects/pad%3A162/notes','POST',{clientId:'delete-image-note',body:'Image',mediaIds:[id]})).data.item;assert.equal((await ca(path,'DELETE')).status,409);await ca('/notes/'+note.id,'DELETE');
    const normalDelete=env.BUCKET.delete.bind(env.BUCKET);env.BUCKET.delete=async()=>{throw Error('Synthetic storage failure');};assert.equal((await ca(path,'DELETE')).status,500);assert.equal((await ca(path)).status,200);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM media WHERE id=?').get(id).count,1);
    env.BUCKET.delete=normalDelete;assert.equal((await ca(path,'DELETE')).status,200);assert.equal((await ca(path)).status,404);assert.equal(env.BUCKET.store.size,0);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM media').get().count,0);checks.push('media removal is owner-only, guards avatar/chat/note references and restores metadata on storage failure');
  });
  await t.test('notes replies, atomic notifications, deep links and recipient isolation',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),c=await register(env,'operator.three'),ca=client(env,a.token),cb=client(env,b.token),cc=client(env,c.token),key='well%3A162%3A3563';
    const parent=(await ca('/objects/'+key+'/notes','POST',{clientId:'parent-note-1',body:'Parent'})).data.item;
    const push=[];const reply=await cb('/objects/'+key+'/notes','POST',{clientId:'reply-note-1',body:'Reply',parentId:parent.id},{},{sendPush:async(...args)=>push.push(args)});assert.equal(reply.status,201,JSON.stringify(reply.data));assert.equal(push.length,1);
    const duplicate=await cb('/objects/'+key+'/notes','POST',{clientId:'reply-note-1',body:'Reply',parentId:parent.id},{},{sendPush:async(...args)=>push.push(args)});assert.equal(duplicate.data.duplicate,true);assert.equal(push.length,1);
    assert.equal((await ca('/notifications/unread-count')).data.count,1);assert.equal((await cc('/notifications/unread-count')).data.count,0);
    const n=(await ca('/notifications')).data.items[0];assert.equal(n.noteId,reply.data.item.id);assert.equal(n.parentId,parent.id);assert.equal(n.actor.id,b.user.id);
    assert.equal((await cc('/notifications/'+n.id+'/read','POST')).status,404);assert.equal((await ca('/notifications/'+n.id+'/read','POST')).status,200);assert.equal((await ca('/notifications/unread-count')).data.count,0);
    assert.equal((await ca('/notes/'+n.noteId)).data.item.body,'Reply');assert.equal((await ca('/notes/'+parent.id,'PATCH',{body:'updated'})).status,200);assert.equal((await cb('/notes/'+parent.id,'DELETE')).status,403);
    assert.equal((await cb('/objects/pad%3A163/notes','POST',{clientId:'bad-parent-note',body:'bad',parentId:parent.id})).status,400);
    assert.equal(env.DB.raw.prepare('SELECT count(*) AS c FROM notifications').get().c,1);checks.push('atomic reply notifications, deep links and recipient isolation');
  });
  await t.test('optimistic samples and statuses include atomic audit',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const initial=(await ca('/samples')).data.items;assert.equal(initial.length,27);assert.ok(initial.every(i=>i.revision===0&&!i.sampled));
    assert.equal((await ca('/samples/162','PUT',{sampled:true,revision:0})).data.item.revision,1);
    const stale=await cb('/samples/162','PUT',{sampled:false,revision:0});assert.equal(stale.status,409);assert.equal(stale.data.error.details.current.revision,1);
    assert.equal((await cb('/samples/162','PUT',{sampled:false,revision:1,note:'new'})).data.item.revision,2);assert.equal(env.DB.raw.prepare('SELECT count(*) AS c FROM sample_audit').get().c,2);
    assert.equal((await ca('/objects/equipment%3A162%3Aagzu/status')).data.status,'unknown');assert.equal((await ca('/objects/equipment%3A162%3Aagzu/status','PUT',{status:'attention',revision:0,note:'Check'})).data.status,'attention');assert.equal((await cb('/objects/equipment%3A162%3Aagzu/status','PUT',{status:'ok',revision:0})).status,409);assert.equal(env.DB.raw.prepare('SELECT count(*) AS c FROM status_audit').get().c,1);checks.push('optimistic state and atomic immutable audit rows');
  });
  await t.test('sampling exclusions hide old marks and reject writes without removing wells or audit',async()=>{
    const env=createEnv(),a=await register(env),call=client(env,a.token),excluded=['165Б','512','165','291','516'],time=Date.now();
    assert.equal(padIds.length,32);assert.equal(samplingPadIds.length,27);assert.deepEqual(padIds.filter(id=>!samplingPadIds.includes(id)).sort(),[...excluded].sort());
    for(const id of excluded){const mutation=crypto.randomUUID();env.DB.raw.prepare('INSERT INTO samples (pad_id,sampled,note,revision,updated_at,updated_by,mutation_id) VALUES (?,?,?,?,?,?,?)').run(id,1,'Existing historical mark',7,time,a.user.id,mutation);env.DB.raw.prepare('INSERT INTO sample_audit (id,pad_id,sampled,note,revision,user_id,created_at) VALUES (?,?,?,?,?,?,?)').run(mutation,id,1,'Existing historical mark',7,a.user.id,time);}
    const before=JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples ORDER BY pad_id').all()),auditBefore=JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit ORDER BY pad_id').all());
    const items=(await call('/samples')).data.items;assert.equal(items.length,27);assert.ok(items.every(item=>!excluded.includes(item.padId)));
    for(const id of excluded){assert.deepEqual((await call('/samples?padId='+encodeURIComponent(id))).data.items,[]);const update=await call('/samples/'+encodeURIComponent(id),'PUT',{sampled:false,revision:7});assert.equal(update.status,400);assert.equal(update.data.error.code,'sampling_excluded');assert.ok(update.data.error.message.includes(id));assert.equal((await call('/samples/'+encodeURIComponent(id),'PUT',{wellIds:[],revision:7})).status,400);assert.equal((await call('/objects/'+encodeURIComponent('pad:'+id)+'/status')).status,200);assert.ok(registry[id].length);assert.equal((await call('/objects/'+encodeURIComponent('well:'+id+':'+registry[id][0])+'/status')).status,200);}
    assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples ORDER BY pad_id').all()),before);assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit ORDER BY pad_id').all()),auditBefore);checks.push('27 sampling pads; five exclusions hide historical marks and reject updates while all pad/well keys and saved audit stay intact');
  });
  await t.test('partial sampling selects only production wells, uses CAS audit and joins both positions',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token),ids=productionWellIds['162'];assert.equal(ids.length,3);
    const initial=(await ca('/samples?padId=162')).data.items[0];assert.deepEqual(initial.productionWellIds,ids);assert.deepEqual(initial.selectedWellIds,[]);assert.equal(initial.totalWells,3);assert.equal(initial.progress,'none');
    const partial=await ca('/samples/162','PUT',{wellIds:[ids[0]],revision:0});assert.equal(partial.status,200);assert.equal(partial.data.item.sampled,false);assert.equal(partial.data.item.sampledCount,1);assert.equal(partial.data.item.progress,'partial');assert.equal(env.DB.raw.prepare('SELECT well_ids FROM sample_audit WHERE pad_id=?').get('162').well_ids,JSON.stringify([ids[0]]));
    const concurrent=await Promise.all([ca('/samples/162','PUT',{wellIds:ids.slice(0,2),revision:1}),cb('/samples/162','PUT',{wellIds:ids,revision:1})]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);const conflict=concurrent.find(r=>r.status===409);assert.equal(conflict.data.error.details.current.revision,2);assert.ok(Array.isArray(conflict.data.error.details.current.selectedWellIds));assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_audit').get().count,2);
    const done=(await ca('/samples/162','PUT',{wellIds:[...ids].reverse().concat(ids[0]),revision:2})).data.item;assert.deepEqual(done.selectedWellIds,ids);assert.equal(done.progress,'done');assert.equal(done.sampled,true);assert.equal(done.sampledCount,3);
    const none=(await ca('/samples/162','PUT',{wellIds:[],revision:3})).data.item;assert.equal(none.progress,'none');assert.equal(none.sampled,false);assert.equal(none.sampledCount,0);assert.equal((await ca('/samples/162','PUT',{sampled:true,revision:4})).data.item.progress,'done');assert.equal((await ca('/samples/162','PUT',{sampled:false,revision:5})).data.item.progress,'none');
    const before=JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples WHERE pad_id=?').get('162')),auditBefore=env.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_audit').get().count;
    for(const body of [{wellIds:[],sampled:false,revision:6},{revision:6},{wellIds:['3563'],revision:6},{wellIds:[productionWellIds['856'][0]],revision:6},{wellIds:["3564'); DROP TABLE samples;--"],revision:6},{wellIds:[3564],revision:6},{wellIds:null,revision:6},{wellIds:Array(101).fill(ids[0]),revision:6}])assert.equal((await ca('/samples/162','PUT',body)).status,400);
    assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples WHERE pad_id=?').get('162')),before);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_audit').get().count,auditBefore);
    const source=JSON.parse(await readFile(new URL('dist/data.json',root),'utf8')),pad=source.pads.find(p=>p.id==='856'),both=pad.positions.map(p=>p.wellIds.find(id=>productionWellIds['856'].includes(id)));assert.ok(both.every(Boolean));const two=(await ca('/samples/856','PUT',{wellIds:both,revision:0})).data.item;assert.equal(two.sampledCount,2);assert.equal(two.progress,'partial');assert.ok(both.every(id=>two.selectedWellIds.includes(id)));checks.push('partial/none/done production selection, both positions, deduplication, invalid/injection rejection and concurrent CAS with atomic selection audit');
  });
  await t.test('legacy NULL sampling projects all/none without rewriting history; zero production is never invented',async()=>{
    const env=createEnv(),a=await register(env),call=client(env,a.token),time=Date.now();
    for(const [id,sampled] of [['162',1],['163',0]]){const mutation=crypto.randomUUID();env.DB.raw.prepare('INSERT INTO samples (pad_id,sampled,note,revision,updated_at,updated_by,mutation_id) VALUES (?,?,?,?,?,?,?)').run(id,sampled,'Legacy sample',4,time,a.user.id,mutation);env.DB.raw.prepare('INSERT INTO sample_audit (id,pad_id,sampled,note,revision,user_id,created_at) VALUES (?,?,?,?,?,?,?)').run(mutation,id,sampled,'Legacy sample',4,a.user.id,time);}
    const rawBefore=JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples ORDER BY pad_id').all()),auditBefore=JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit ORDER BY pad_id').all());const legacy=(await call('/samples?padId=162')).data.items[0];assert.deepEqual(legacy.selectedWellIds,productionWellIds['162']);assert.equal(legacy.progress,'done');assert.equal(legacy.sampled,true);assert.equal((await call('/samples?padId=163')).data.items[0].progress,'none');assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples ORDER BY pad_id').all()),rawBefore);assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit ORDER BY pad_id').all()),auditBefore);
    const saved=productionWellIds['162'];try{productionWellIds['162']=[];const empty=(await call('/samples?padId=162')).data.items[0];assert.equal(empty.totalWells,0);assert.equal(empty.sampledCount,0);assert.equal(empty.progress,'none');assert.equal(empty.sampled,false);assert.deepEqual(empty.selectedWellIds,[]);}finally{productionWellIds['162']=saved;}
    assert.equal((await call('/samples/162','PUT',{wellIds:[saved[0]],revision:4})).status,200);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_audit WHERE well_ids IS NULL').get().count,2);assert.equal(env.DB.raw.prepare('SELECT well_ids FROM samples WHERE pad_id=?').get('162').well_ids,JSON.stringify([saved[0]]));checks.push('old NULL true/false marks project compatibly, old audit stays NULL, explicit edits store JSON and zero-production stays none');
  });
  await t.test('equipment positions keep notes and states separate with legacy alias to first',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const old='equipment:856:agzu',p1='equipment:856:p1:agzu',p2='equipment:856:p2:agzu',path=key=>'/objects/'+encodeURIComponent(key);
    assert.equal((await ca(path(old)+'/status','PUT',{status:'attention',revision:0})).status,200);
    assert.equal((await cb(path(p1)+'/status')).data.status,'attention');assert.equal((await cb(path(p2)+'/status')).data.status,'unknown');
    assert.equal((await cb(path(p2)+'/status','PUT',{status:'ok',revision:0})).status,200);assert.equal((await ca(path(old)+'/status')).data.status,'attention');
    const first=(await ca(path(old)+'/notes','POST',{clientId:'position-one-note',body:'First position'})).data.item;assert.equal(first.objectKey,p1);
    assert.equal((await cb(path(p1)+'/notes')).data.items.length,1);assert.equal((await cb(path(p2)+'/notes')).data.items.length,0);
    const second=(await ca(path(p2)+'/notes','POST',{clientId:'position-two-note',body:'Second position'})).data.item;
    assert.equal((await cb(path(p2)+'/notes','POST',{clientId:'position-bad-parent',body:'Wrong position',parentId:first.id})).status,400);
    assert.equal((await cb(path(p2)+'/notes','POST',{clientId:'position-two-reply',body:'Reply to second',parentId:second.id})).status,201);
    const notification=(await ca('/notifications')).data.items[0];assert.equal(notification.objectKey,p2);assert.equal(notification.objectLabel,'АГЗУ · куст №856 · 2-я позиция');
    const rackKey='equipment:856:p2:cable-racks',rackParent=(await ca(path(rackKey)+'/notes','POST',{clientId:'rack-legacy-parent',body:'Existing equipment note'})).data.item;
    await cb(path(rackKey)+'/notes','POST',{clientId:'rack-legacy-reply',body:'Existing equipment reply',parentId:rackParent.id});
    const rackNotification=(await ca('/notifications')).data.items.find(n=>n.objectKey===rackKey),oldLabel='Кабельные стойки · куст №856 · 2-я позиция';env.DB.raw.prepare('UPDATE notifications SET object_label=? WHERE id=?').run(oldLabel,rackNotification.id);
    assert.equal((await ca('/notifications/'+rackNotification.id)).data.item.objectLabel,'Эстакада · куст №856 · 2-я позиция');assert.equal(env.DB.raw.prepare('SELECT object_label FROM notifications WHERE id=?').get(rackNotification.id).object_label,oldLabel,'read projection preserves persisted historical labels');
    assert.equal((await ca(path('equipment:856:p3:agzu')+'/status')).status,400);assert.equal((await ca(path('equipment:862:p2:agzu')+'/status')).status,400);
    assert.equal((await ca(path('equipment:862:p1:agzu')+'/notes','POST',{clientId:'single-position-note',body:'Single'})).data.item.objectKey,'equipment:862:agzu');
    assert.deepEqual(env.DB.raw.prepare('SELECT object_key FROM object_statuses ORDER BY object_key').all().map(r=>r.object_key),[p1,p2]);checks.push('position-specific equipment states, notes, notifications and legacy first-position alias');
  });
  await t.test('equipment absent is reversible, audited and isolated from other positions and object kinds',async()=>{
    const env=createEnv(),a=await register(env),call=client(env,a.token),p1='equipment:856:p1:agzu',p2='equipment:856:p2:agzu',state=key=>'/objects/'+encodeURIComponent(key)+'/status';
    const absent=await call(state(p1),'PUT',{status:'absent',revision:0,note:'Оборудование отсутствует'});assert.equal(absent.status,200);assert.equal(absent.data.status,'absent');assert.equal(absent.data.revision,1);
    assert.equal((await call(state(p2))).data.status,'unknown');assert.equal((await call(state('equipment:856:agzu'))).data.status,'absent');
    assert.equal((await call(state(p2),'PUT',{status:'ok',revision:0})).status,200);assert.equal((await call(state(p1))).data.status,'absent');
    const restored=await call(state(p1),'PUT',{status:'ok',revision:1});assert.equal(restored.status,200);assert.equal(restored.data.revision,2);assert.equal(restored.data.status,'ok');
    assert.deepEqual(env.DB.raw.prepare('SELECT status,revision FROM status_audit WHERE object_key=? ORDER BY revision').all(p1).map(r=>({...r})),[{status:'absent',revision:1},{status:'ok',revision:2}]);assert.equal((await call(state(p2))).data.revision,1);
    assert.equal((await call(state(p1),'PUT',{status:'absent',revision:1})).status,409);
    for(const key of ['pad:856','well:856:476В']){const result=await call(state(key),'PUT',{status:'absent',revision:0});assert.equal(result.status,400);assert.equal(result.data.error.code,'equipment_status_only');assert.equal((await call(state(key))).data.revision,0);}
    const invalid=await call(state(p1),'PUT',{status:'invented',revision:2});assert.equal(invalid.status,400);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS count FROM status_audit').get().count,3);
    assert.equal((await call(state('equipment:862:drainage'),'PUT',{status:'absent',revision:0})).data.status,'absent');checks.push('equipment-only absent reverses to ok with revision audit, independent positions, and pad/well/invalid-state rejection');
  });
  await t.test('shared calendar with owner deletion and valid ranges',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const saved=await ca('/shifts','POST',{date:'2026-11-13',kind:'night',note:'night shift'});assert.equal(saved.status,201);const id=saved.data.item.id;
    assert.equal((await cb('/shifts?from=2026-11-01&to=2026-11-30')).data.items.length,1);assert.equal((await cb('/shifts/'+id,'DELETE')).status,403);assert.equal((await ca('/shifts','POST',{date:'2026-02-30',kind:'day'})).status,400);assert.equal((await ca('/shifts?from=2026-01-01&to=2026-11-30')).status,400);assert.equal((await ca('/shifts/'+id,'DELETE')).status,200);checks.push('shared calendar validation and owner deletion');
    const exact=await ca('/shifts','POST',{date:'2026-11-13',kind:'night',startAt:'2026-11-13T20:00:00+05:00',endAt:'2026-11-14T08:00:00+05:00'});assert.equal(exact.status,201);assert.equal(exact.data.item.startAt,'2026-11-13T15:00:00.000Z');
    assert.equal((await ca('/shifts','POST',{date:'2026-11-14',kind:'night',startAt:'2026-11-13T20:00:00+05:00',endAt:'2026-11-14T08:00:00+05:00'})).status,400);
  });
  await t.test('push subscriptions isolated and provider endpoints restricted',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token),endpoint='https://fcm.googleapis.com/fcm/send/test';
    const keys={p256dh:base64url(new Uint8Array([4,...new Uint8Array(64)])),auth:base64url(new Uint8Array(16))};
    assert.equal((await ca('/push/public-key')).data.publicKey,null);assert.equal((await ca('/push/subscriptions','POST',{endpoint,keys})).status,200);assert.equal((await cb('/push/subscriptions','POST',{endpoint,keys})).status,409);await cb('/push/subscriptions','DELETE',{endpoint});assert.equal(env.DB.raw.prepare('SELECT count(*) AS c FROM push_subscriptions').get().c,1);
    assert.equal((await ca('/push/subscriptions','POST',{endpoint:'https://127.0.0.1/private',keys})).status,400);await ca('/push/subscriptions','DELETE',{endpoint});assert.equal(env.DB.raw.prepare('SELECT count(*) AS c FROM push_subscriptions').get().c,0);checks.push('push provider allowlist and subscription isolation');
  });
  await t.test('failed login throttling persists and prunes expired rows',async()=>{
    const env=createEnv(),call=client(env);for(let i=0;i<10;i++)assert.equal((await call('/auth/login','POST',{login:'missing.user',password:'wrong password'})).status,401);
    const limited=await call('/auth/login','POST',{login:'missing.user',password:'wrong password'});assert.equal(limited.status,429);assert.ok(Number(limited.response.headers.get('Retry-After'))>0);
    assert.ok(!JSON.stringify(env.DB.raw.prepare('SELECT * FROM rate_limits').all()).includes('missing.user'));checks.push('persistent bounded brute-force throttling');
  });
  await t.test('native FCM registration, secret ownership, rotation, session logout and device bounds',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token);
    const device={installationId:crypto.randomUUID(),installationSecret:base64url(crypto.getRandomValues(new Uint8Array(32))),token:'synthetic-fcm-registration-token-one',platform:'android',appVersion:'2.0.3'};
    assert.equal((await client(env)('/devices/fcm/config')).status,401);assert.deepEqual((await ca('/devices/fcm/config')).data,{enabled:false});
    const registered=await ca('/devices/fcm','POST',device);assert.equal(registered.status,200,JSON.stringify(registered.data));assert.equal(registered.data.enabled,false);assert.ok(!JSON.stringify(registered.data).includes(device.token));
    const stored=env.DB.raw.prepare('SELECT * FROM native_push_tokens').get();assert.equal(stored.session_hash,await sha256(a.token));assert.equal(stored.installation_hash,await sha256(device.installationId));assert.equal(stored.secret_hash,await sha256(device.installationSecret));assert.equal(stored.token_hash,await sha256(device.token));
    assert.equal((await cb('/devices/fcm','POST',device)).status,409);assert.equal((await cb('/devices/fcm','POST',{...device,replaceOwner:true,installationSecret:'x'.repeat(43)})).status,403);
    const rotated={...device,token:'synthetic-fcm-registration-token-two'};assert.equal((await ca('/devices/fcm','POST',rotated)).data.deviceId,registered.data.deviceId);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,1);
    const renewed=await client(env)('/auth/login','POST',{login:'operator.one',password:'long password 123'}),renewedCall=client(env,renewed.data.token);assert.equal((await renewedCall('/devices/fcm','POST',rotated)).status,200);
    await ca('/devices/fcm','DELETE',{installationId:device.installationId,installationSecret:device.installationSecret});assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,1,'old same-user session cannot unbind renewed session');
    assert.equal((await cb('/devices/fcm','POST',{...rotated,replaceOwner:true})).status,200);assert.equal(env.DB.raw.prepare('SELECT user_id FROM native_push_tokens').get().user_id,b.user.id);
    await ca('/devices/fcm','DELETE',device);await ca('/auth/logout','POST');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,1,'old owner logout cannot delete new owner device');
    assert.equal((await cb('/devices/fcm','DELETE',{...device,installationSecret:'y'.repeat(43)})).status,400,'delete rejects unknown request fields');
    assert.equal((await cb('/devices/fcm','DELETE',{installationId:device.installationId,installationSecret:'y'.repeat(43)})).status,403);
    await cb('/devices/fcm','DELETE',{installationId:device.installationId,installationSecret:device.installationSecret});assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,0);
    for(let i=0;i<10;i++)assert.equal((await cb('/devices/fcm','POST',{...device,installationId:crypto.randomUUID(),token:'synthetic-fcm-device-token-'+i})).status,200);
    assert.equal((await cb('/devices/fcm','POST',{...device,installationId:crypto.randomUUID(),token:'synthetic-fcm-device-token-eleven'})).data.error.code,'device_limit');
    assert.equal((await cb('/devices/fcm','POST',{...device,installationId:crypto.randomUUID(),token:'bad\nregistration token'})).status,400);
    assert.equal((await cb('/devices/fcm','POST',{...device,installationId:crypto.randomUUID(),token:'x'.repeat(4097)})).status,400);
    await cb('/auth/logout','POST');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,0);checks.push('FCM installation secret, explicit account rebind, rotation, ten-device cap and session-scoped logout');
  });
  await t.test('native FCM stale authenticated registration cannot outlive logout or overwrite a rebound owner',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token),device={installationId:crypto.randomUUID(),installationSecret:base64url(crypto.getRandomValues(new Uint8Array(32))),token:'synthetic-fcm-race-token-one',platform:'android'};
    await ca('/devices/fcm','POST',device);
    const originalBatch=env.DB.batch.bind(env.DB);let intercept=true;
    env.DB.batch=async statements=>{if(intercept&&statements[0]?.sql.startsWith('UPDATE sessions SET token_hash=token_hash')){intercept=false;env.DB.raw.prepare('UPDATE native_push_tokens SET user_id=?,session_hash=?').run(b.user.id,await sha256(b.token));}return originalBatch(statements);};
    assert.equal((await ca('/devices/fcm','POST',{...device,token:'synthetic-fcm-race-token-stale'})).status,409);assert.equal(env.DB.raw.prepare('SELECT user_id FROM native_push_tokens').get().user_id,b.user.id);
    await cb('/devices/fcm','DELETE',{installationId:device.installationId,installationSecret:device.installationSecret});intercept=true;
    env.DB.batch=async statements=>{if(intercept&&statements[0]?.sql.startsWith('UPDATE sessions SET token_hash=token_hash')){intercept=false;env.DB.raw.prepare('UPDATE sessions SET revoked_at=1 WHERE token_hash=?').run(await sha256(a.token));}return originalBatch(statements);};
    const stale=await ca('/devices/fcm','POST',device);assert.equal(stale.status,401,JSON.stringify(stale.data));assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,0);checks.push('transactional session recheck and owner CAS defeat stale registration after logout/account switch');
  });
  await t.test('native FCM same-user session and token CAS preserve newer bindings against delayed requests',async()=>{
    const env=createEnv(),a=await register(env),oldCall=client(env,a.token),device={installationId:crypto.randomUUID(),installationSecret:base64url(crypto.getRandomValues(new Uint8Array(32))),token:'synthetic-same-user-initial-token',platform:'android'};
    await oldCall('/devices/fcm','POST',device);
    const login=await client(env)('/auth/login','POST',{login:'operator.one',password:'long password 123'}),newToken=login.data.token,newCall=client(env,newToken),newHash=await sha256(newToken),newDeviceToken='synthetic-same-user-newest-token',newDeviceHash=await sha256(newDeviceToken),originalBatch=env.DB.batch.bind(env.DB);let intercept=true;
    env.DB.batch=async statements=>{if(intercept&&statements[0]?.sql.startsWith('UPDATE sessions SET token_hash=token_hash')){intercept=false;env.DB.raw.prepare('UPDATE native_push_tokens SET session_hash=?,token_hash=?,token=?').run(newHash,newDeviceHash,newDeviceToken);}return originalBatch(statements);};
    assert.equal((await oldCall('/devices/fcm','POST',{...device,token:'synthetic-same-user-delayed-token'})).status,409,'in-flight old session must fail captured binding CAS');
    assert.equal(env.DB.raw.prepare('SELECT session_hash FROM native_push_tokens').get().session_hash,newHash);
    assert.equal((await oldCall('/devices/fcm','POST',device)).data.error.code,'device_session_conflict','old session starting after rebind cannot take it back');
    assert.equal((await oldCall('/devices/fcm','DELETE',{installationId:device.installationId,installationSecret:device.installationSecret})).status,200);assert.equal(env.DB.raw.prepare('SELECT session_hash FROM native_push_tokens').get().session_hash,newHash);
    assert.equal((await newCall('/devices/fcm','POST',{...device,token:newDeviceToken})).status,200);
    intercept=true;env.DB.batch=async statements=>{if(intercept&&statements[0]?.sql.startsWith('UPDATE sessions SET token_hash=token_hash')){intercept=false;env.DB.raw.prepare('UPDATE native_push_tokens SET token_hash=?,token=?').run('newest-concurrent-token-hash','synthetic-concurrent-rotation-token');}return originalBatch(statements);};
    assert.equal((await newCall('/devices/fcm','POST',{...device,token:'synthetic-overwritten-token-attempt'})).status,409,'same-session rotation also compares captured token hash');assert.equal(env.DB.raw.prepare('SELECT token_hash FROM native_push_tokens').get().token_hash,'newest-concurrent-token-hash');
    await oldCall('/auth/logout','POST');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,1);await newCall('/auth/logout','POST');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM native_push_tokens').get().c,0);checks.push('old same-user DELETE/logout/late POST and concurrent session/token updates preserve the latest binding');
  });
  await t.test('sampling circles reset projection with monotonic revisions and preserve history;31 is readonly',async()=>{
    const env=createEnv(),a=await register(env),call=client(env,a.token),ids=productionWellIds['162'];let time=Date.parse('2026-11-07T23:59:59+05:00');env.DB.clock=()=>time;
    const first=await call('/samples/162','PUT',{wellIds:[ids[0]],revision:0,note:'First circle'});assert.equal(first.status,200);assert.equal(first.data.period.key,'2026-11:r1');assert.equal(first.data.item.periodKey,'2026-11:r1');const oldAudit=JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit').all());
    time=Date.parse('2026-11-08T00:00:00+05:00');const next=(await call('/samples?padId=162')).data;assert.equal(next.period.key,'2026-11:r2');assert.equal(next.items[0].revision,1);assert.deepEqual(next.items[0].selectedWellIds,[]);assert.equal(next.items[0].note,'');assert.equal(next.items[0].updatedAt,null);assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit').all()),oldAudit);
    const stale=await call('/samples/162','PUT',{periodKey:'2026-11:r1',wellIds:[ids[0]],revision:1});assert.equal(stale.status,409);assert.equal(stale.data.error.code,'sampling_period_changed');assert.equal(stale.data.error.details.period.key,'2026-11:r2');
    assert.equal((await call('/samples/162','PUT',{periodKey:undefined,wellIds:[],revision:1})).data.error.code,'sampling_period_required');
    assert.equal((await call('/samples/162','PUT',{wellIds:[ids[1]],revision:1})).data.item.revision,2);assert.equal(env.DB.raw.prepare('SELECT round_key FROM samples').get().round_key,'2026-11:r2');assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit WHERE revision=1').all()),oldAudit);
    time=Date.parse('2026-11-30T12:00:00+05:00');assert.equal((await call('/samples/162','PUT',{sampled:true,revision:2})).data.item.revision,3);
    time=Date.parse('2026-12-31T12:00:00+05:00');const december=(await call('/samples?padId=162')).data;assert.equal(december.period.isBreak,true);assert.equal(december.period.key,'2026-12:r4');assert.deepEqual(december.items[0].selectedWellIds,[],'last month mark is not shown as this month');
    time=Date.parse('2026-11-30T12:00:00+05:00');time+=86400000; // December1 begins a new month, no November31 exists.
    assert.equal((await call('/samples?padId=162')).data.period.key,'2026-12:r1');
    time=Date.parse('2026-12-30T12:00:00+05:00');assert.equal((await call('/samples/162','PUT',{sampled:true,revision:3})).data.item.revision,4);
    time=Date.parse('2026-12-31T12:00:00+05:00');const rest=(await call('/samples?padId=162')).data;assert.equal(rest.period.isBreak,true);assert.equal(rest.items[0].sampled,true);assert.equal(rest.items[0].revision,4);assert.equal(rest.period.nextStartDate,'2027-01-01');const blocked=await call('/samples/162','PUT',{wellIds:[],revision:4});assert.equal(blocked.status,409);assert.equal(blocked.data.error.code,'sampling_break');assert.equal(blocked.data.error.details.period.isBreak,true);
    time=Date.parse('2027-01-01T00:00:00+05:00');const january=(await call('/samples?padId=162')).data;assert.equal(january.items[0].revision,4);assert.equal(january.items[0].sampled,false);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM sample_audit').get().c,4);checks.push('Period-key projections reset visible marks only, revision/history persist; stale/missing periods reject and31 retains readonly4th-circle results');
  });
  await t.test('sampling SQL checks the database clock when INSERT or UPDATE crosses midnight',async()=>{
    for(const existing of [false,true]){
      const env=createEnv(),a=await register(env),call=client(env,a.token),ids=productionWellIds['162'];let time=Date.parse('2026-11-07T23:59:59.999+05:00');env.DB.clock=()=>time;
      if(existing)assert.equal((await call('/samples/162','PUT',{wellIds:[ids[0]],revision:0})).status,200);
      const oldRows=JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples').all()),oldAudit=JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit').all()),batch=env.DB.batch.bind(env.DB);let intercept=true;
      env.DB.batch=async statements=>{if(intercept&&/^(INSERT INTO|UPDATE) samples\b/.test(statements[0]?.sql)){intercept=false;time=Date.parse('2026-11-08T00:00:00+05:00');}return batch(statements);};
      const result=await call('/samples/162','PUT',{periodKey:'2026-11:r1',wellIds:[ids[1]],revision:existing?1:0});assert.equal(result.status,409,JSON.stringify(result.data));assert.equal(result.data.error.code,'sampling_period_changed');assert.equal(result.data.error.details.period.key,'2026-11:r2');assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM samples').all()),oldRows);assert.equal(JSON.stringify(env.DB.raw.prepare('SELECT * FROM sample_audit').all()),oldAudit);
    }checks.push('Database-time predicates reject first-write and update races across UTC+5 midnight without changing marks or audit');
  });
  await t.test('scheduled circle notifications bootstrap quietly, deduplicate and preserve work/chat recipient isolation',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),ca=client(env,a.token),cb=client(env,b.token),scheduler=client(env),secret=base64url(crypto.getRandomValues(new Uint8Array(32))),headers=()=>schedulerHeaders(secret,env.DB.clock()),pushes=[],hooks={sendPush:async(_env,users,payload)=>pushes.push({users,payload})};env.SAMPLING_CRON_SECRET=secret;let time=Date.parse('2026-11-13T12:00:00+05:00');env.DB.clock=()=>time;
    assert.equal((await ca('/internal/sampling-round','POST',{})).status,401);assert.equal((await scheduler('/internal/sampling-round','POST',{}, {'X-Atlas-Scheduler':'x'.repeat(43)})).status,401);
    const baseline=await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(baseline.data.bootstrap,true);assert.equal(pushes.length,0);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,0);
    time=Date.parse('2026-11-16T00:00:00+05:00');const results=await Promise.all([scheduler('/internal/sampling-round','POST',{},headers,hooks),scheduler('/internal/sampling-round','POST',{},headers,hooks)]);assert.equal(results.reduce((sum,r)=>sum+r.data.created,0),2);assert.equal(pushes.length,2);assert.equal(new Set(pushes.map(p=>p.payload.notificationId)).size,2);assert.ok(pushes.every(p=>p.payload.type==='sampling-round'&&p.payload.objectKey==='sampling'));
    const work=(await ca('/notifications?type=work')).data.items;assert.equal(work.length,1);assert.equal(work[0].actor,null);assert.equal(work[0].noteId,null);assert.equal(work[0].parentId,null);assert.equal(work[0].periodKey,'2026-11:r3');assert.equal(work[0].period.startDate,'2026-11-16');assert.equal((await ca('/notifications?type=comment')).data.items.length,0);assert.equal((await cb('/notifications/'+work[0].id)).status,404);assert.equal((await ca('/notifications/'+work[0].id)).data.item.type,'sampling-round');
    await ca('/chat/messages','POST',{clientId:'circle-filter-chat',body:'Chat after circle'});assert.equal((await cb('/notifications/unread-count')).data.count,2);await cb('/notifications/read-all?type=comment','POST');assert.equal((await cb('/notifications/unread-count')).data.count,2);await cb('/notifications/read-all?type=work','POST');assert.equal((await cb('/notifications/unread-count')).data.count,1);assert.equal((await cb('/notifications?unread=1&type=chat')).data.items.length,1);assert.equal((await ca('/notifications/unread-count')).data.count,1);
    await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(pushes.length,2);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM sample_round_events').get().c,2);checks.push('Secret-only scheduled bootstrap; atomic one notification/profile/period, simultaneous-job dedup, nullable system actor, work alias and recipient isolation');
  });
  await t.test('scheduled circle delivery resumes bounded persisted batches after a worker failure',async()=>{
    const env=createEnv(),a=await register(env),scheduler=client(env),secret=base64url(crypto.getRandomValues(new Uint8Array(32))),headers=()=>schedulerHeaders(secret,env.DB.clock()),pushes=[],hooks={sendPush:async(_env,users,payload)=>pushes.push({users,payload})};env.SAMPLING_CRON_SECRET=secret;let time=Date.parse('2026-11-13T12:00:00+05:00');env.DB.clock=()=>time;
    for(let i=0;i<22;i++)env.DB.raw.prepare('INSERT INTO profiles (id,login,password_hash,nickname,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),'local.scheduler.'+i,'synthetic-unused-hash','Local fixture','operator',1,1);
    await scheduler('/internal/sampling-round','POST',{},headers,hooks);time=Date.parse('2026-11-16T00:00:00+05:00');const prepare=env.DB.prepare.bind(env.DB);let failOnce=true;
    env.DB.prepare=sql=>{if(failOnce&&sql.startsWith('SELECT id,recipient_id,seq FROM notifications')){failOnce=false;throw Error('Synthetic worker interrupted before dispatch');}return prepare(sql);};
    const created=await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(created.data.created,23);assert.equal(pushes.length,0);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,23);
    time+=121000;await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(pushes.length,20);assert.equal(env.DB.raw.prepare('SELECT completed_at FROM sample_round_events WHERE period_key=?').get('2026-11:r3').completed_at,null);
    await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(pushes.length,23);assert.equal(new Set(pushes.map(p=>p.payload.notificationId)).size,23);assert.ok(env.DB.raw.prepare('SELECT completed_at FROM sample_round_events WHERE period_key=?').get('2026-11:r3').completed_at);await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(pushes.length,23);checks.push('Durable ledger/lease resumes interrupted work, at most20 recipients per invocation, stable opaque IDs and completed jobs do not repeat');
  });
  await t.test('scheduled push retries only transient recipients three times with60/120s backoff',async()=>{
    const env=createEnv(),a=await register(env),b=await register(env,'operator.two'),c=await register(env,'operator.three'),d=await register(env,'operator.four'),scheduler=client(env),secret=base64url(crypto.getRandomValues(new Uint8Array(32))),headers=()=>schedulerHeaders(secret,env.DB.clock()),attempts=new Map(),ids=new Map();env.SAMPLING_CRON_SECRET=secret;let time=Date.parse('2026-11-13T12:00:00+05:00');env.DB.clock=()=>time;
    const hooks={sendPush:async(_env,[user],payload)=>{const n=(attempts.get(user)??0)+1;attempts.set(user,n);const prior=ids.get(user);if(prior)assert.equal(payload.notificationId,prior);ids.set(user,payload.notificationId);return [{status:'fulfilled',value:{retryable:user===a.user.id||user===d.user.id&&n===1?1:0,failed:user===b.user.id?1:0,sent:0}}];}};
    await scheduler('/internal/sampling-round','POST',{},headers,hooks);time=Date.parse('2026-11-16T00:00:00+05:00');await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.size,4);let event=env.DB.raw.prepare('SELECT * FROM sample_round_events WHERE period_key=?').get('2026-11:r3');assert.equal(JSON.parse(event.retry_ids).length,2);assert.equal(event.completed_at,null);
    await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.get(a.user.id),1,'backoff is respected before60s');time+=60000;await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.get(a.user.id),2);assert.equal(attempts.get(d.user.id),2);assert.equal(attempts.get(b.user.id),1,'permanent error is not repeated');assert.equal(attempts.get(c.user.id),1,'no subscriptions is not repeated');
    time+=60000;await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.get(a.user.id),2,'second backoff is120s');time+=60000;await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.get(a.user.id),3);assert.equal(attempts.get(d.user.id),2);event=env.DB.raw.prepare('SELECT * FROM sample_round_events WHERE period_key=?').get('2026-11:r3');assert.deepEqual(JSON.parse(event.retry_ids),[]);assert.ok(event.completed_at);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,4);time+=600000;await scheduler('/internal/sampling-round','POST',{},headers,hooks);assert.equal(attempts.get(a.user.id),3);checks.push('Per-recipient durable transient queue retries at60/120s, cap3attempts, stable IDs; success/permanent/no-subscription recipients never repeated');
  });
  await t.test('scheduler accepts only method/path-bound short-lived HMAC proofs; queue never receives static secret',async()=>{
    const env=createEnv(),call=client(env),secret=base64url(crypto.getRandomValues(new Uint8Array(32))),time=Date.parse('2026-11-13T12:00:00+05:00');env.DB.clock=()=>time;env.SAMPLING_CRON_SECRET=secret;
    const correct=await schedulerHeaders(secret,time);assert.ok(!JSON.stringify(correct).includes(secret));
    for(const invalid of [await schedulerHeaders(secret,time-120001),await schedulerHeaders(secret,time+30001),await schedulerHeaders(secret,time,'GET'),await schedulerHeaders(secret,time,'POST','/internal/other'),await schedulerHeaders('x'.repeat(43),time),{...correct,'X-Atlas-Scheduler-Time':String(time+1)},{...correct,'X-Atlas-Scheduler-Time':'NaN'},{...correct,'X-Atlas-Scheduler-Time':'9999999999999999'},{...correct,'X-Atlas-Scheduler':secret}])assert.equal((await call('/internal/sampling-round','POST',{},invalid)).status,401);
    assert.equal((await call('/internal/sampling-round','GET',null,correct)).status,405);assert.equal((await call('/internal/sampling-round','POST',{periodKey:'future'},correct)).status,400);
    const accepted=await call('/internal/sampling-round','POST',{},correct);assert.equal(accepted.status,200);assert.equal(accepted.data.bootstrap,true);assert.equal((await call('/internal/sampling-round','POST',{},correct)).data.created,0);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM sample_round_events').get().c,1);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,0);checks.push('HMAC method/path/timestamp signature,120s expiry/+30s clock skew, malformed/tampered/raw-secret rejection and harmless idempotent replay');
  });
});
await writeFile(new URL('qa/api-test-report.json',root),JSON.stringify({checkedAt:new Date().toISOString(),runtime:process.version,storage:'Node SQLite D1 adapter + in-memory R2',passed:true,checks},null,2)+'\n');
