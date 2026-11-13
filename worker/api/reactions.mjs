import {all,first,run,fail,now,json,ownKeys,bodyJson} from './core.mjs';

export const reactionEmojis=Object.freeze(['👍','❤️','🔥','👏','👀','✅']);
export async function messageReactions(env,messageIds,viewerId){
  const ids=[...new Set(messageIds.filter(Boolean))],result=new Map(ids.map(id=>[id,[]]));if(!ids.length)return result;
  const rows=await all(env,'SELECT message_id,emoji,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM chat_reactions WHERE message_id IN (SELECT value FROM json_each(?)) GROUP BY message_id,emoji',viewerId,JSON.stringify(ids));
  for(const row of rows)result.get(row.message_id)?.push({emoji:row.emoji,count:Number(row.count),mine:Number(row.mine)===1});
  for(const values of result.values())values.sort((a,b)=>reactionEmojis.indexOf(a.emoji)-reactionEmojis.indexOf(b.emoji));return result;
}
export async function handleReactions(request,env,path,user){
  const match=path.match(/^\/chat\/messages\/([A-Za-z0-9-]{1,64})\/reaction$/);if(!match||request.method!=='PUT')return null;
  const id=match[1];if(!await first(env,'SELECT id FROM chat_messages WHERE id=?',id))fail(404,'not_found','Сообщение не найдено.');
  const body=await bodyJson(request);ownKeys(body,['emoji']);if(!Object.hasOwn(body,'emoji')||body.emoji!==null&&!reactionEmojis.includes(body.emoji))fail(400,'invalid_reaction','Выберите доступную реакцию.');
  if(body.emoji===null)await run(env,'DELETE FROM chat_reactions WHERE message_id=? AND user_id=?',id,user.id);
  else {const time=now();await run(env,'INSERT INTO chat_reactions (message_id,user_id,emoji,created_at,updated_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM chat_messages WHERE id=?) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji,updated_at=excluded.updated_at WHERE chat_reactions.emoji<>excluded.emoji',id,user.id,body.emoji,time,time,id);}
  if(!await first(env,'SELECT id FROM chat_messages WHERE id=?',id))fail(404,'not_found','Сообщение уже удалено.');
  return json({reactions:(await messageReactions(env,[id],user.id)).get(id)??[]});
}
