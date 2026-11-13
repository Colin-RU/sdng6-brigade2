import {all,first,run,fail,now,iso,uuid,json,text,ownKeys,bodyJson,authorFrom,pageArgs} from './core.mjs';
import {mediaForIds,mediaView} from './media.mjs';
import {messageReactions} from './reactions.mjs';
import {objectKey,padId,registry,productionWellIds,positionRegistry} from '../registry.mjs';
import {replyNotificationStatement,dispatchReplyPush,chatNotificationStatement,dispatchChatPush} from './notifications.mjs';
const joins=' JOIN profiles p ON p.id=m.user_id ';
const columns='m.*,p.login,p.nickname,p.position,p.grade,p.avatar_media_id';
function sharedPadView(id){return id?{id,label:'Куст '+id,wellCount:registry[id]?.length??0,productionWellCount:productionWellIds[id]?.length??0,positionCount:positionRegistry[id]?.length??0}:null;}
function mentionedIds(row){return row.mentioned_user_ids?JSON.parse(row.mentioned_user_ids):[];}
async function mentionProfiles(env,ids){
  const unique=[...new Set(ids)];if(!unique.length)return new Map();
  const rows=await all(env,'SELECT id,login,nickname FROM profiles WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(unique));return new Map(rows.map(row=>[row.id,row]));
}
async function resolveMentions(env,body){
  // Match complete @logins, excluding email addresses and partial longer logins.
  const logins=[...new Set([...body.matchAll(/(^|[^\p{L}\p{N}\p{M}_@.+-])@([a-z0-9][a-z0-9._-]{2,39})(?![\p{L}\p{N}\p{M}._-])/giu)].map(match=>match[2].toLowerCase()))];
  if(!logins.length)return [];
  const rows=await all(env,'SELECT id,login,nickname FROM profiles WHERE login IN (SELECT value FROM json_each(?))',JSON.stringify(logins));
  if(rows.length>50)fail(400,'too_many_mentions','В одном сообщении можно упомянуть до 50 коллег.');
  return rows;
}
async function replyViews(env,ids){
  const unique=[...new Set(ids.filter(Boolean))];if(!unique.length)return new Map();
  const rows=await all(env,`SELECT ${columns} FROM chat_messages m ${joins} WHERE m.id IN (SELECT value FROM json_each(?))`,JSON.stringify(unique));
  return new Map(rows.map(row=>[row.id,{id:row.id,deleted:false,body:row.body.slice(0,240),author:authorFrom(row),mediaCount:JSON.parse(row.media_ids).length,sharedPad:sharedPadView(row.shared_pad_id)}]));
}
async function view(env,row,mediaMap=null,replyMap=null,mentionMap=null,reactionMap=null,viewerId=null) {
  const ids=JSON.parse(row.media_ids),media=mediaMap?ids.map(id=>mediaMap.get(id)).filter(Boolean):await mediaForIds(env,ids);
  const replies=replyMap??await replyViews(env,[row.reply_to_id]);
  const mentions=mentionMap??await mentionProfiles(env,mentionedIds(row));
  const reactions=row.object_key?[]:(reactionMap??await messageReactions(env,[row.id],viewerId)).get(row.id)??[];
  return {id:row.id,cursor:String(row.seq),clientId:row.client_id,body:row.body,author:authorFrom(row),media,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),revision:row.revision,...(row.object_key?{objectKey:row.object_key,parentId:row.parent_id??null}:{replyTo:row.reply_to_id?replies.get(row.reply_to_id)??{id:row.reply_to_id,deleted:true}:null,sharedPad:sharedPadView(row.shared_pad_id),mentions:mentionedIds(row).map(id=>mentions.get(id)).filter(Boolean),reactions})};
}
async function readPage(env,table,url,key=null,viewerId=null) {
  const {before,after,limit}=pageArgs(url),args=[],where=[];
  if(key!==null){where.push('m.object_key=?');args.push(key);}
  if(before){where.push('m.seq<?');args.push(before);}
  if(after){where.push('m.seq>?');args.push(after);}
  const rows=await all(env,`SELECT ${columns} FROM ${table} m ${joins}${where.length?'WHERE '+where.join(' AND '):''} ORDER BY m.seq ${after?'ASC':'DESC'} LIMIT ?`,...args,limit+1);
  const more=rows.length>limit;if(more)rows.pop();if(!after)rows.reverse();
  const ids=[...new Set(rows.flatMap(r=>JSON.parse(r.media_ids)))];
  const mediaRows=ids.length?await all(env,'SELECT * FROM media WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(ids)):[];
  const mediaMap=new Map(mediaRows.map(r=>[r.id,mediaView(r)]));
  const replies=await replyViews(env,rows.map(row=>row.reply_to_id));
  const mentions=await mentionProfiles(env,rows.flatMap(mentionedIds));
  const reactions=table==='chat_messages'?await messageReactions(env,rows.map(row=>row.id),viewerId):new Map();
  return json({items:await Promise.all(rows.map(r=>view(env,r,mediaMap,replies,mentions,reactions,viewerId))),nextCursor:more?String(after?rows.at(-1).seq:rows[0].seq):null});
}
async function createMessage(request,env,user,table,key=null,ctx=null,hooks={}) {
  const b=await bodyJson(request);ownKeys(b,key===null?['clientId','body','mediaIds','replyToId','sharedPadId']:['clientId','body','mediaIds','parentId']);
  const clientId=text(b.clientId,'clientId',8,80);if(!/^[A-Za-z0-9_-]+$/.test(clientId))fail(400,'invalid_input','Некорректный clientId.');
  const body=text(b.body??'','body',0,4000),ids=b.mediaIds??[];
  const replyToId=key===null&&b.replyToId!=null?text(b.replyToId,'replyToId',1,64):null,sharedPadId=key===null&&b.sharedPadId!=null?padId(b.sharedPadId):null;
  if(replyToId&&!/^[A-Za-z0-9-]+$/.test(replyToId))fail(400,'invalid_reply','Некорректное исходное сообщение.');
  const media=await mediaForIds(env,ids,user.id);if(!body&&!media.length&&!sharedPadId)fail(400,'empty_message','Введите текст, добавьте изображение или данные куста.');
  const parentId=b.parentId==null?null:text(b.parentId,'parentId',1,64);
  const parent=parentId?await first(env,'SELECT id,user_id FROM object_notes WHERE id=? AND object_key=?',parentId,key):null;
  if(parentId&&!parent)fail(400,'invalid_parent','Исходная заметка не найдена на этом объекте.');
  const existing=await first(env,`SELECT ${columns} FROM ${table} m ${joins} WHERE m.user_id=? AND m.client_id=?`,user.id,clientId);
  const contextMatches=row=>key!==null?row.object_key===key&&(row.parent_id??null)===parentId:(row.reply_to_id??null)===replyToId&&(row.shared_pad_id??null)===sharedPadId;
  if(existing){if(!contextMatches(existing)||existing.body!==body||existing.media_ids!==JSON.stringify(ids))fail(409,'idempotency_conflict','Этот запрос уже использован для другой записи.');return json({item:await view(env,existing,null,null,null,null,user.id),duplicate:true});}
  if(replyToId&&!await first(env,'SELECT id FROM chat_messages WHERE id=?',replyToId))fail(400,'invalid_reply','Исходное сообщение уже удалено. Выберите другое или отмените ответ.');
  const mentionedUserIds=key===null?(await resolveMentions(env,body)).map(profile=>profile.id):[];
  const id=uuid(),time=now();
  const cols=['id','user_id','client_id','body','media_ids','created_at','updated_at','revision'],values=[id,user.id,clientId,body,JSON.stringify(ids),time,time,1];
  if(key!==null){cols.push('object_key','parent_id');values.push(key,parentId);}
  else{cols.push('reply_to_id','shared_pad_id','mentioned_user_ids');values.push(replyToId,sharedPadId,JSON.stringify(mentionedUserIds));}
  // A simultaneous retry is resolved by the unique user/clientId key.
  const insert=env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON CONFLICT(user_id,client_id) DO NOTHING`).bind(...values);
  const note={id,object_key:key,body:body||(sharedPadId?'Куст №'+sharedPadId:''),mentionedUserIds};
  if(key===null){const results=await env.DB.batch([insert,chatNotificationStatement(env,user,note)]);dispatchChatPush(env,results[1].results??[],note,user,ctx,hooks);}
  else if(parent&&parent.user_id!==user.id){const results=await env.DB.batch([insert,replyNotificationStatement(env,user,note,parent)]);if(results[1].results?.length)dispatchReplyPush(env,[parent.user_id],results[1].results[0].id,note,parent,ctx,hooks,user);}
  else await insert.run();
  const saved=await first(env,`SELECT ${columns} FROM ${table} m ${joins} WHERE m.user_id=? AND m.client_id=?`,user.id,clientId);
  if(saved.body!==body||saved.media_ids!==JSON.stringify(ids)||!contextMatches(saved))fail(409,'idempotency_conflict','Этот запрос уже использован для другой записи.');
  return json({item:await view(env,saved,null,null,null,null,user.id),duplicate:saved.id!==id},saved.id===id?201:200);
}
async function editMessage(request,env,user,table,id) {
  const row=await first(env,`SELECT * FROM ${table} WHERE id=?`,id);if(!row)fail(404,'not_found','Запись не найдена.');if(row.user_id!==user.id)fail(403,'forbidden','Можно изменять только свои записи.');
  if(request.method==='DELETE'){await run(env,`DELETE FROM ${table} WHERE id=? AND user_id=?`,id,user.id);return json({ok:true});}
  const b=await bodyJson(request);ownKeys(b,['body','mediaIds','revision']);
  const revision=b.revision??row.revision;if(!Number.isInteger(revision)||revision<1)fail(400,'invalid_input','Некорректная версия записи.');
  const body='body'in b?text(b.body,'body',0,4000):row.body;
  const ids='mediaIds'in b?b.mediaIds:JSON.parse(row.media_ids);await mediaForIds(env,ids,user.id);if(!body&&!ids.length&&!row.shared_pad_id)fail(400,'empty_message','Введите текст или добавьте изображение.');
  const mentionUpdate=table==='chat_messages'?',mentioned_user_ids=?':'',args=[body,JSON.stringify(ids),now()];
  if(mentionUpdate)args.push(JSON.stringify((await resolveMentions(env,body)).map(profile=>profile.id)));
  const changed=await first(env,`UPDATE ${table} SET body=?,media_ids=?,revision=revision+1,updated_at=?${mentionUpdate} WHERE id=? AND user_id=? AND revision=? RETURNING id`,...args,id,user.id,revision);
  if(!changed)fail(409,'revision_conflict','Запись уже изменена. Обновите данные.');
  return json({item:await view(env,await first(env,`SELECT ${columns} FROM ${table} m ${joins} WHERE m.id=?`,id),null,null,null,null,user.id)});
}
export async function handleMessages(request,env,path,user,ctx,hooks) {
  if(path==='/chat/messages') {if(request.method==='GET')return readPage(env,'chat_messages',new URL(request.url),null,user.id);if(request.method==='POST')return createMessage(request,env,user,'chat_messages',null,ctx,hooks);}
  let m=path.match(/^\/objects\/([^/]+)\/notes$/);
  if(m){const key=objectKey(decodeURIComponent(m[1]));if(request.method==='GET')return readPage(env,'object_notes',new URL(request.url),key,user.id);if(request.method==='POST')return createMessage(request,env,user,'object_notes',key,ctx,hooks);}
  m=path.match(/^\/(notes|chat\/messages)\/([A-Za-z0-9-]{1,64})$/);
  if(m&&request.method==='GET'){const row=await first(env,`SELECT ${columns} FROM ${m[1]==='notes'?'object_notes':'chat_messages'} m ${joins} WHERE m.id=?`,m[2]);if(!row)fail(404,'not_found','Запись не найдена.');return json({item:await view(env,row,null,null,null,null,user.id)});}
  if(m&&['PATCH','DELETE'].includes(request.method))return editMessage(request,env,user,m[1]==='notes'?'object_notes':'chat_messages',m[2]);
  return null;
}
