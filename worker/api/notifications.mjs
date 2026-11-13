import {all,first,run,fail,now,iso,uuid,json,text,choice,ownKeys,bodyJson,authorFrom,pageArgs,unbase64url} from './core.mjs';
import {periodFromKey} from './sampling-periods.mjs';
export function notificationView(row){const label=(row.object_key?.startsWith('equipment:')&&row.object_key.endsWith(':cable-racks')||row.object_key?.startsWith('well:')&&row.object_key.split(':')[2]?.includes('Ш'))?objectLabel(row.object_key):row.object_label;let mentioned=[];try{const parsed=JSON.parse(row.message_mentioned_user_ids??'[]');if(Array.isArray(parsed))mentioned=parsed;}catch{}return {id:row.id,cursor:String(row.seq),actor:row.actor_id?{id:row.actor_id,nickname:row.nickname,avatarId:row.avatar_media_id??null,avatarMediaId:row.avatar_media_id??null}:null,type:row.type,isMention:row.type==='chat'&&mentioned.includes(row.recipient_id),objectKey:row.object_key,objectLabel:label,noteId:row.note_id,parentId:row.parent_id,preview:row.preview,createdAt:iso(row.created_at),readAt:iso(row.read_at),periodKey:row.round_key??null,period:periodFromKey(row.round_key)};}
function objectLabel(key){const parts=key.split(':'),[type,pad,item]=parts;if(type==='pad')return `Куст №${pad}`;if(type==='well')return item.includes('Ш')?`Шурф №${item} · куст №${pad}`:pad==='ОД'?`Отдельная скважина №${item}`:`Скважина №${item} · куст №${pad}`;const names={'agzu':'АГЗУ','btma':'БТМА','bg':'БГ','drainage':'Дренажная ёмкость','control-stations':'Станции управления','cable-racks':'Эстакада'},kind=parts.at(-1),position=parts.length===4?Number(item.slice(1)):null;return `${names[kind]??'Оборудование'} · куст №${pad}${position?` · ${position}-я позиция`:''}`;}
export function replyNotificationStatement(env,user,note,parent) {
  const id=uuid(),time=now(),label=objectLabel(note.object_key);
  // The note insert and this conditional notification run in one D1 transaction.
  return env.DB.prepare('INSERT INTO notifications (id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM object_notes WHERE id=?) ON CONFLICT(recipient_id,note_id) DO NOTHING RETURNING id').bind(id,parent.user_id,user.id,'comment',note.object_key,label,note.id,parent.id,note.body.slice(0,160),time,note.id);
}
export function dispatchReplyPush(env,userIds,id,note,parent,ctx,hooks={},actor=null) {
  if(hooks.sendPush&&ctx?.waitUntil)ctx.waitUntil(Promise.resolve().then(()=>hooks.sendPush(env,userIds,{type:'comment',notificationId:id,objectKey:note.object_key,noteId:note.id,parentId:parent.id,title:`${objectLabel(note.object_key)} · ${actor?.nickname||'Новый комментарий'}`,body:note.body.slice(0,160)||'Добавлено изображение'})).catch(()=>{}));
}
export function chatNotificationStatement(env,user,message) {
  // Both UUIDs are server generated. Their 32+32 hex digits form a stable,
  // recipient-specific opaque ID, distinct from 36-character reply UUIDs.
  return env.DB.prepare(`INSERT INTO notifications (id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at) SELECT replace(?,'-','')||replace(p.id,'-',''),p.id,?,'chat','chat','Чат бригады',?,?,?,? FROM profiles p WHERE p.id<>? AND EXISTS (SELECT 1 FROM chat_messages WHERE id=?) ON CONFLICT(recipient_id,note_id) DO NOTHING RETURNING id,recipient_id`).bind(message.id,user.id,message.id,message.id,message.body.slice(0,160)||'Добавлено изображение',now(),user.id,message.id);
}
export function dispatchChatPush(env,notifications,message,actor,ctx,hooks={}) {
  if(!notifications.length||!hooks.sendPush||!ctx?.waitUntil)return;
  ctx.waitUntil((async()=>{
    // Each recipient needs their own notification ID. Keep delivery bounded,
    // while persisted notifications already exist for every other profile.
    for(let offset=0;offset<notifications.length;offset+=2)await Promise.all(notifications.slice(offset,offset+2).map(n=>Promise.resolve().then(()=>hooks.sendPush(env,[n.recipient_id],{type:'chat',notificationId:n.id,objectKey:'chat',noteId:message.id,parentId:message.id,title:`${message.mentionedUserIds?.includes(n.recipient_id)?'Вас упомянули':'Чат бригады'} · ${actor.nickname}`,body:message.body.slice(0,160)||'Добавлено изображение'})).catch(()=>{})));
  })());
}
function subscriptionEndpoint(value){const endpoint=text(value,'endpoint',1,2048);let url;try{url=new URL(endpoint);}catch{fail(400,'invalid_subscription','Некорректная подписка.');}
  // Push delivery is restricted to known browser push providers to avoid arbitrary server fetches.
  const host=url.hostname;const allowed=host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.push.services.mozilla.com')||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host==='wns2-db5p.notify.windows.com'||host.endsWith('.notify.windows.com');
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed)fail(400,'invalid_subscription','Неподдерживаемый сервис уведомлений.');return url.href;
}
export async function handleNotifications(request,env,path,user) {
  if(path==='/notifications/unread-count'&&request.method==='GET')return json({count:(await first(env,'SELECT COUNT(*) AS count FROM notifications WHERE recipient_id=? AND read_at IS NULL',user.id)).count});
  if(path==='/notifications'&&request.method==='GET'){
    const url=new URL(request.url),{before,after,limit}=pageArgs(url),args=[user.id],where=['n.recipient_id=?'],type=url.searchParams.get('type');
    if(type!==null){choice(type,'type',['chat','comment','sampling-round','work']);where.push(type==='work'?"n.type IN ('comment','sampling-round')":'n.type=?');if(type!=='work')args.push(type);}
    if(url.searchParams.get('unread')==='1'||url.searchParams.get('unread')==='true')where.push('n.read_at IS NULL');
    if(before){where.push('n.seq<?');args.push(before);}if(after){where.push('n.seq>?');args.push(after);}
    const rows=await all(env,`SELECT n.*,p.nickname,p.avatar_media_id,cm.mentioned_user_ids AS message_mentioned_user_ids FROM notifications n LEFT JOIN profiles p ON p.id=n.actor_id LEFT JOIN chat_messages cm ON n.type='chat' AND cm.id=n.note_id WHERE ${where.join(' AND ')} ORDER BY n.seq ${after?'ASC':'DESC'} LIMIT ?`,...args,limit+1);const more=rows.length>limit;if(more)rows.pop();if(!after)rows.reverse();return json({items:rows.map(notificationView),nextCursor:more?String(after?rows.at(-1).seq:rows[0].seq):null});
  }
  if(path==='/notifications/read-all'&&request.method==='POST'){const type=new URL(request.url).searchParams.get('type');if(type!==null)choice(type,'type',['chat','comment','sampling-round','work']);await run(env,`UPDATE notifications SET read_at=? WHERE recipient_id=? AND read_at IS NULL${type==='work'?" AND type IN ('comment','sampling-round')":type!==null?' AND type=?':''}`,now(),user.id,...(type!==null&&type!=='work'?[type]:[]));return json({ok:true});}
  let m=path.match(/^\/notifications\/([A-Za-z0-9-]{1,64})\/read$/);
  if(m&&request.method==='POST'){const row=await first(env,'SELECT id FROM notifications WHERE id=? AND recipient_id=?',m[1],user.id);if(!row)fail(404,'not_found','Уведомление не найдено.');await run(env,'UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?',now(),m[1],user.id);return json({ok:true});}
  m=path.match(/^\/notifications\/([A-Za-z0-9-]{1,64})$/);
  if(m&&request.method==='GET'){const row=await first(env,"SELECT n.*,p.nickname,p.avatar_media_id,cm.mentioned_user_ids AS message_mentioned_user_ids FROM notifications n LEFT JOIN profiles p ON p.id=n.actor_id LEFT JOIN chat_messages cm ON n.type='chat' AND cm.id=n.note_id WHERE n.id=? AND n.recipient_id=?",m[1],user.id);if(!row)fail(404,'not_found','Уведомление не найдено.');return json({item:notificationView(row)});}
  if(path==='/push/public-key'&&request.method==='GET')return json({publicKey:env.VAPID_PUBLIC_KEY??null});
  if(path==='/push/subscriptions'&&request.method==='POST'){
    const b=await bodyJson(request);ownKeys(b,['endpoint','keys','expirationTime']);const endpoint=subscriptionEndpoint(b.endpoint);if(!b.keys||typeof b.keys!=='object'||Array.isArray(b.keys))fail(400,'invalid_subscription','Некорректная подписка.');ownKeys(b.keys,['p256dh','auth']);
    const p256dh=text(b.keys.p256dh,'p256dh',1,128),auth=text(b.keys.auth,'auth',1,64);let publicBytes,authBytes;try{publicBytes=unbase64url(p256dh);authBytes=unbase64url(auth);}catch{fail(400,'invalid_subscription','Некорректная подписка.');}if(publicBytes.length!==65||publicBytes[0]!==4||authBytes.length!==16)fail(400,'invalid_subscription','Некорректная подписка.');
    const count=(await first(env,'SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?',user.id)).count;
    const old=await first(env,'SELECT id,user_id FROM push_subscriptions WHERE endpoint=?',endpoint);if(old&&old.user_id!==user.id)fail(409,'subscription_conflict','Подписка уже связана с другим профилем.');if(!old&&count>=10)fail(409,'subscription_limit','Достигнут лимит устройств.');
    await run(env,'INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth',old?.id??uuid(),user.id,endpoint,p256dh,auth,now());return json({ok:true});
  }
  if(path==='/push/subscriptions'&&request.method==='DELETE'){const b=await bodyJson(request);ownKeys(b,['endpoint']);const endpoint=subscriptionEndpoint(b.endpoint);await run(env,'DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?',endpoint,user.id);return json({ok:true});}
  return null;
}
