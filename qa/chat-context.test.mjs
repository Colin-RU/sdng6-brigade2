import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {handleApi} from '../worker/api/index.mjs';
import {registry,productionWellIds,positionRegistry} from '../worker/registry.mjs';
import {postgresSql} from '../worker/adapters/supabase.mjs';

const migrationFiles=(await readdir(new URL('sqlite-migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();
const schema=(await Promise.all(migrationFiles.map(n=>readFile(new URL('sqlite-migrations/'+n,import.meta.url),'utf8')))).join('\n');
class Statement {
 constructor(owner,sql,args=[]){Object.assign(this,{owner,sql,args});}
 bind(...args){return new Statement(this.owner,this.sql,args);}
 execute(){const statement=this.owner.raw.prepare(this.sql);if(statement.columns().length){const results=statement.all(...this.args);return {success:true,results,meta:{changes:results.length}};}const info=statement.run(...this.args);return {success:true,results:[],meta:{changes:Number(info.changes)}};}
 async first(column){const row=this.execute().results[0]??null;await this.owner.afterFirst?.(this.sql,this.args,row);return column&&row?row[column]:row;}
 async all(){return this.execute();}async run(){return this.execute();}
}
class D1 {
 constructor(){this.raw=new DatabaseSync(':memory:');this.raw.function('atlas_now_ms',()=>Date.now());this.raw.exec('PRAGMA foreign_keys=ON;');this.raw.exec(schema);}
 prepare(sql){(this.queries??=[]).push(sql);return new Statement(this,sql);}
 async batch(statements){this.raw.exec('BEGIN');try{const results=statements.map(s=>s.execute());this.raw.exec('COMMIT');return results;}catch(error){this.raw.exec('ROLLBACK');throw error;}}
}
let ip=0;
function client(env,token){const address='198.51.100.'+(++ip);return async(path,method='GET',body,hooks={})=>{const headers=new Headers({'CF-Connecting-IP':address});if(token)headers.set('Authorization','Bearer '+token);if(body!==undefined)headers.set('Content-Type','application/json');const tasks=[];const response=await handleApi(new Request('https://atlas.example/api/v1'+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),env,{waitUntil:p=>tasks.push(p)},hooks);await Promise.all(tasks);return {status:response.status,data:await response.json()};};}
async function fixture(){const env={DB:new D1(),BUCKET:{async get(){return null;},async put(){},async delete(){}}},users=[];for(const login of ['operator.one','operator.two','operator.three']){const result=await client(env)('/auth/register','POST',{login,password:'test password123',nickname:login,position:'operator',grade:4});assert.equal(result.status,200);users.push(result.data);}return {env,users,calls:users.map(u=>client(env,u.token))};}
const checks=[];
async function check(name,fn){await test(name,async()=>{try{await fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:error.message});throw error;}});}
const post=(call,clientId,body,extra={},hooks={})=>call('/chat/messages','POST',{clientId,body,...extra},hooks);

await check('Quotes follow current text/profile, keep deletion marker and support unchanged retry',async()=>{
 const {env,calls:[a,b]}=await fixture();try{
  const parent=(await post(a,'context-parent-one','Исходный текст')).data.item;
  const payload={clientId:'context-reply-one',body:'Ответ',replyToId:parent.id,sharedPadId:'856'};
  const reply=await b('/chat/messages','POST',payload);assert.equal(reply.status,201);assert.equal(reply.data.item.replyTo.body,'Исходный текст');assert.equal(reply.data.item.replyTo.author.login,'operator.one');
  assert.equal((await a('/chat/messages/'+parent.id,'PATCH',{body:'Обновлённая цитата'})).status,200);await a('/me','PATCH',{nickname:'Новое имя автора'});
  const updated=(await b('/chat/messages/'+reply.data.item.id)).data.item;assert.equal(updated.replyTo.body,'Обновлённая цитата');assert.equal(updated.replyTo.author.nickname,'Новое имя автора');
  assert.equal((await b('/chat/messages','POST',payload)).data.duplicate,true);
  await a('/chat/messages/'+parent.id,'DELETE');const deleted=(await b('/chat/messages/'+reply.data.item.id)).data.item;assert.deepEqual(deleted.replyTo,{id:parent.id,deleted:true});assert.equal(deleted.body,'Ответ');
  const retry=await b('/chat/messages','POST',payload);assert.equal(retry.status,200);assert.equal(retry.data.duplicate,true);assert.equal(retry.data.item.replyTo.deleted,true);
  assert.equal((await post(b,'context-new-after-delete','Новый ответ',{replyToId:parent.id})).status,400);
  assert.equal((await b('/chat/messages')).data.items.find(m=>m.id===reply.data.item.id).replyTo.deleted,true);
 }finally{env.DB.raw.close();}
});
await check('Shared-pad-only messages validate registry and preserve immutable context',async()=>{
 const {env,calls:[a]}=await fixture();try{
  const card=await post(a,'shared-card-empty','',{sharedPadId:'856'});assert.equal(card.status,201);assert.equal(card.data.item.body,'');assert.deepEqual(card.data.item.sharedPad,{id:'856',label:'Куст 856',wellCount:registry['856'].length,productionWellCount:productionWellIds['856'].length,positionCount:positionRegistry['856'].length});
  for(const sharedPadId of ['unknown','ОД',856])assert.equal((await post(a,'shared-invalid-'+String(sharedPadId),'',{sharedPadId})).status,400);
  const note=(await a('/objects/pad%3A162/notes','POST',{clientId:'context-object-note',body:'Заметка объекта'})).data.item;
  for(const replyToId of [note.id,'missing-parent-id','../bad'])assert.equal((await post(a,'bad-reply-'+crypto.randomUUID(),'Text',{replyToId})).status,400);
  for(const extra of [{replyToId:note.id},{sharedPadId:'162'},{mentionedUserIds:['spoofed']}])assert.equal((await a('/chat/messages/'+card.data.item.id,'PATCH',{body:'New',...extra})).status,400);
  const changed=await a('/chat/messages/'+card.data.item.id,'PATCH',{body:''});assert.equal(changed.status,200);assert.equal(changed.data.item.sharedPad.id,'856');
 }finally{env.DB.raw.close();}
});
await check('Recipient-specific mentions and push titles update projection without extra edit notifications',async()=>{
 const {env,users,calls:[a,b,c]}=await fixture(),push=[];try{
  const response=await post(a,'mention-exact-create','Проверьте @OPERATOR.TWO и @operator.two, не a@operator.three и не @operator.three-more',{}, {sendPush:async(...args)=>push.push(args)});assert.equal(response.status,201);const item=response.data.item;
  assert.deepEqual(item.mentions.map(m=>m.id),[users[1].user.id]);for(const m of item.mentions)assert.deepEqual(Object.keys(m).sort(),['id','login','nickname']);
  const bn=(await b('/notifications')).data.items[0],cn=(await c('/notifications')).data.items[0];assert.equal(bn.isMention,true);assert.equal(cn.isMention,false);assert.notEqual(bn.id,cn.id);assert.equal(push.length,2);
  assert.match(push.find(p=>p[1][0]===users[1].user.id)[2].title,/^Вас упомянули/);assert.match(push.find(p=>p[1][0]===users[2].user.id)[2].title,/^Чат бригады/);
  assert.equal((await a('/notifications')).data.items.length,0);assert.equal((await c('/notifications/'+bn.id)).status,404);
  await a('/chat/messages/'+item.id,'PATCH',{body:'Теперь @operator.three'});assert.deepEqual((await b('/chat/messages/'+item.id)).data.item.mentions.map(m=>m.id),[users[2].user.id]);assert.equal((await b('/notifications/'+bn.id)).data.item.isMention,false);assert.equal((await c('/notifications/'+cn.id)).data.item.isMention,true);assert.equal(push.length,2);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,2);
  await a('/chat/messages/'+item.id,'DELETE');assert.equal((await b('/notifications/'+bn.id)).data.item.isMention,false);
 }finally{env.DB.raw.close();}
});
await check('Mention scanner matches exact complete logins, case-insensitively, outside email and longer names',async()=>{
 const {env,users,calls:[a]}=await fixture();try{
  const vectors=[['(@operator.two)!',true],['@OPERATOR.TWO',true],['mail@operator.two',false],['mail+tag@operator.two',false],['@@operator.two',false],['@operator.two-long',false],['@operator.two_more',false],['@operator.two.extra',false],['@operator.twoЖ',false],['@operator.twoé',false],['@operator.two\u0301',false],['@operator.two١',false],['x@operator.two',false],['@operator.two @operator.two',true]];
  const failures=[];for(let i=0;i<vectors.length;i++){const [body,expected]=vectors[i],result=await post(a,'mention-vector-'+i,body);assert.equal(result.status,201);const actual=result.data.item.mentions.some(m=>m.id===users[1].user.id);if(actual!==expected)failures.push({body,expected,actual});}assert.deepEqual(failures,[]);
 }finally{env.DB.raw.close();}
});
await check('Concurrent identical retries and conflicting contexts create only one message and notification set',async()=>{
 const {env,calls:[a,b]}=await fixture();try{
  const parent=(await post(a,'parallel-parent-one','Parent')).data.item,other=(await post(a,'parallel-parent-two','Other')).data.item;
  async function pair(clientId,left,right){let reached=0,release;const gate=new Promise(resolve=>release=resolve);env.DB.afterFirst=async(sql,args,row)=>{if(sql.includes('m.user_id=? AND m.client_id=?')&&args[1]===clientId&&row===null){if(++reached===2)release();await gate;}};const before=env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,push=[];const both=await Promise.all([b('/chat/messages','POST',{clientId,body:'Parallel',...left},{sendPush:async(...args)=>push.push(args)}),b('/chat/messages','POST',{clientId,body:'Parallel',...right},{sendPush:async(...args)=>push.push(args)})]);env.DB.afterFirst=null;assert.equal(reached,2);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE client_id=?').get(clientId).c,1);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c-before,2);assert.equal(push.length,2);return both;}
  assert.deepEqual((await pair('parallel-identical',{replyToId:parent.id,sharedPadId:'162'},{replyToId:parent.id,sharedPadId:'162'})).map(r=>r.status).sort(),[200,201]);
  assert.deepEqual((await pair('parallel-context-conflict',{replyToId:parent.id,sharedPadId:'162'},{replyToId:other.id,sharedPadId:'856'})).map(r=>r.status).sort(),[201,409]);
 }finally{env.DB.raw.close();}
});
await check('Context endpoints require authentication and prevent another author changing a message',async()=>{
 const {env,calls:[a,b]}=await fixture();try{
  const message=(await post(a,'access-context-message','Private authenticated chat',{sharedPadId:'162'})).data.item,anonymous=client(env);
  for(const [path,method,body]of [['/chat/messages','GET'],['/chat/messages/'+message.id,'GET'],['/chat/messages','POST',{clientId:'anonymous-create',body:'x',replyToId:message.id}],['/chat/messages/'+message.id,'PATCH',{body:'x'}]])assert.equal((await anonymous(path,method,body)).status,401);
  assert.equal((await b('/chat/messages/'+message.id,'PATCH',{body:'Cannot change'})).status,403);assert.equal((await b('/chat/messages/'+message.id,'DELETE')).status,403);
 }finally{env.DB.raw.close();}
});
await check('Reactions are idempotent, viewer-specific, allowlisted, batched and cascade without notifications',async()=>{
 const {env,users,calls:[a,b,c]}=await fixture();try{
  const first=(await post(a,'reaction-message-one','Message')).data.item,second=(await post(a,'reaction-message-two','Another')).data.item,path='/chat/messages/'+first.id+'/reaction',put=(call,emoji)=>call(path,'PUT',{emoji});assert.deepEqual(first.reactions,[]);
  const beforeNotifications=env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,push=[];
  assert.deepEqual((await b(path,'PUT',{emoji:'👍'},{sendPush:async(...args)=>push.push(args)})).data.reactions,[{emoji:'👍',count:1,mine:true}]);const saved=env.DB.raw.prepare('SELECT * FROM chat_reactions').get();await put(b,'👍');assert.deepEqual(env.DB.raw.prepare('SELECT * FROM chat_reactions').get(),saved);
  await put(c,'👍');assert.deepEqual((await b('/chat/messages/'+first.id)).data.item.reactions,[{emoji:'👍',count:2,mine:true}]);assert.deepEqual((await a('/chat/messages/'+first.id)).data.item.reactions,[{emoji:'👍',count:2,mine:false}]);
  assert.deepEqual((await put(c,'🔥')).data.reactions,[{emoji:'👍',count:1,mine:false},{emoji:'🔥',count:1,mine:true}]);await put(c,null);await put(c,null);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_reactions').get().c,1);
  for(const emoji of ['💣','❤',true,[],{},'👍👍'])assert.equal((await put(b,emoji)).status,400);assert.equal((await b(path,'PUT',{})).status,400);assert.equal((await b(path,'PUT',{emoji:'✅',userId:users[2].user.id})).status,400);assert.equal((await client(env)(path,'PUT',{emoji:'✅'})).status,401);assert.equal((await b('/chat/messages/no-such-message/reaction','PUT',{emoji:'✅'})).status,404);
  await c('/chat/messages/'+second.id+'/reaction','PUT',{emoji:'✅'});env.DB.queries=[];const page=(await b('/chat/messages')).data.items;assert.equal(env.DB.queries.filter(sql=>sql.includes('FROM chat_reactions')).length,1);assert.deepEqual(page.find(m=>m.id===second.id).reactions,[{emoji:'✅',count:1,mine:false}]);assert.equal((await a('/chat/messages/'+first.id)).data.item.revision,1);
  await Promise.all([put(b,'👏'),put(c,'👀')]);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_reactions WHERE message_id=?').get(first.id).c,2);await Promise.all([put(b,'🔥'),put(b,'✅')]);assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_reactions WHERE message_id=? AND user_id=?').get(first.id,users[1].user.id).c,1);assert.equal(env.DB.raw.prepare('SELECT emoji FROM chat_reactions WHERE message_id=? AND user_id=?').get(first.id,users[2].user.id).emoji,'👀');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM notifications').get().c,beforeNotifications);assert.equal(push.length,0);await a('/chat/messages/'+first.id,'DELETE');assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_reactions WHERE message_id=?').get(first.id).c,0);assert.equal((await put(b,'👍')).status,404);
  const race=(await post(a,'reaction-delete-race','Delete before insert')).data.item;let intercepted=false;env.DB.afterFirst=async(sql,args,row)=>{if(!intercepted&&row&&sql==='SELECT id FROM chat_messages WHERE id=?'&&args[0]===race.id){intercepted=true;env.DB.raw.prepare('DELETE FROM chat_messages WHERE id=?').run(race.id);}};assert.equal((await b('/chat/messages/'+race.id+'/reaction','PUT',{emoji:'👍'})).status,404);env.DB.afterFirst=null;assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM chat_reactions WHERE message_id=?').get(race.id).c,0);
  assert.ok(postgresSql('SELECT * FROM chat_reactions').includes('FROM brigade."chat_reactions"'));assert.deepEqual(env.DB.raw.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{env.DB.raw.close();}
});
await check('Colleague profiles are authenticated public fields only, read-only and current',async()=>{
 const {env,users,calls:[a,b]}=await fixture();try{
  const path='/profiles/'+users[1].user.id,result=await a(path);assert.equal(result.status,200);assert.deepEqual(Object.keys(result.data.user).sort(),['avatarMediaId','createdAt','grade','id','login','nickname','position','updatedAt']);assert.equal(result.data.user.login,'operator.two');assert.equal((await client(env)(path)).status,401);assert.equal((await a('/profiles/no-such-profile')).status,404);
  assert.equal((await a(path,'PATCH',{nickname:'Cannot edit colleague'})).status,404);assert.equal((await a(path,'DELETE')).status,404);await b('/me','PATCH',{nickname:'Обновлённый коллега'});assert.equal((await a(path)).data.user.nickname,'Обновлённый коллега');assert.equal((await a('/profiles/%27%20OR%201%3D1')).status,404);
  assert.equal((await a('/me')).data.user.id,users[0].user.id);
 }finally{env.DB.raw.close();}
});
const sourceFiles=['worker/api/messages.mjs','worker/api/reactions.mjs','worker/api/notifications.mjs','worker/api/auth.mjs','worker/adapters/supabase.mjs'];
await writeFile(new URL('chat-context-report.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),passed:checks.every(c=>c.passed),runtime:process.version,storage:'Real in-memory SQLite; actual handleApi and transactional D1 adapter; synthetic accounts only',productionMutations:false,sourceHashes:Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex')]))),checks},null,2)+'\n');
