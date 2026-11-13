import {all,first,run,fail,now,uuid,json,ownKeys,bodyJson,sha256} from './core.mjs';
import {fcmConfigured} from '../fcm.mjs';

function installation(body){
  if(typeof body.installationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.installationId)||typeof body.installationSecret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.installationSecret))fail(400,'invalid_device','Некорректные данные устройства.');
  return Promise.all([sha256(body.installationId.toLowerCase()),sha256(body.installationSecret)]);
}
function tokenValue(value){if(typeof value!=='string'||value.length<20||value.length>4096||!/^[\x21-\x7e]+$/.test(value))fail(400,'invalid_device','Некорректный токен уведомлений.');return value;}
function sameHash(a,b){let diff=a.length^b.length;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^(b.charCodeAt(i)??0);return diff===0;}

export async function handleDevices(request,env,path,user){
  if(path==='/devices/fcm/config'&&request.method==='GET')return json({enabled:fcmConfigured(env)});
  if(path!=='/devices/fcm'||!['POST','DELETE'].includes(request.method))return null;
  const b=await bodyJson(request);
  ownKeys(b,request.method==='POST'?['installationId','installationSecret','token','platform','appVersion','replaceOwner']:['installationId','installationSecret']);
  const [installationHash,secretHash]=await installation(b);
  const old=await first(env,'SELECT d.id,d.user_id,d.secret_hash,d.device_slot,d.session_hash,d.token_hash,s.created_at AS bound_session_created_at FROM native_push_tokens d JOIN sessions s ON s.token_hash=d.session_hash WHERE d.installation_hash=?',installationHash);
  if(request.method==='DELETE'){
    // A stale logout from another profile must never unbind the current owner.
    if(old?.user_id===user.id){if(!sameHash(old.secret_hash,secretHash))fail(403,'device_secret_mismatch','Не удалось подтвердить устройство.');await run(env,'DELETE FROM native_push_tokens WHERE id=? AND user_id=? AND secret_hash=? AND session_hash=?',old.id,user.id,secretHash,user.token_hash);}
    return json({ok:true});
  }
  if(b.platform!=='android'||('replaceOwner'in b&&typeof b.replaceOwner!=='boolean')||('appVersion'in b&&(typeof b.appVersion!=='string'||b.appVersion.length>32||!/^[\w.+-]*$/.test(b.appVersion))))fail(400,'invalid_device','Некорректные данные устройства.');
  const token=tokenValue(b.token),tokenHash=await sha256(token),time=now();
  if(old&&!sameHash(old.secret_hash,secretHash))fail(403,'device_secret_mismatch','Не удалось подтвердить устройство.');
  if(old&&old.user_id!==user.id&&b.replaceOwner!==true)fail(409,'device_owner_conflict','Устройство связано с другим профилем. Подтвердите смену профиля.');
  // An older login cannot take back an installation already renewed by a later
  // login of the same profile, even if this delayed request starts after rebind.
  if(old?.user_id===user.id&&old.session_hash!==user.token_hash&&Number(user.session_created_at)<=Number(old.bound_session_created_at))fail(409,'device_session_conflict','Уведомления устройства уже связаны с более новым входом. Войдите снова.');
  const duplicate=await first(env,'SELECT id FROM native_push_tokens WHERE token_hash=?',tokenHash);
  if(duplicate&&duplicate.id!==old?.id)fail(409,'device_token_conflict','Токен уже связан с другим устройством. Обновите регистрацию уведомлений.');
  // Expired sessions cannot reserve the ten device slots forever.
  await run(env,'DELETE FROM native_push_tokens WHERE user_id=? AND id<>? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash=native_push_tokens.session_hash AND s.expires_at>? AND s.revoked_at IS NULL)',user.id,old?.id??'',time);
  const occupied=await all(env,'SELECT device_slot FROM native_push_tokens WHERE user_id=?',user.id),slots=new Set(occupied.map(r=>r.device_slot));
  const slot=old?.user_id===user.id?old.device_slot:Array.from({length:10},(_,i)=>i+1).find(i=>!slots.has(i));
  if(!slot)fail(409,'device_limit','Достигнут лимит: 10 устройств для одного профиля.');
  const id=old?.id??uuid(),active='EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>? AND revoked_at IS NULL)';
  const statement=old
    ?env.DB.prepare(`UPDATE native_push_tokens SET user_id=?,session_hash=?,token_hash=?,token=?,device_slot=?,app_version=?,updated_at=? WHERE id=? AND user_id=? AND secret_hash=? AND session_hash=? AND token_hash=? AND ${active} RETURNING id`).bind(user.id,user.token_hash,tokenHash,token,slot,b.appVersion??null,time,id,old.user_id,secretHash,old.session_hash,old.token_hash,user.token_hash,user.id,time)
    :env.DB.prepare(`INSERT INTO native_push_tokens (id,installation_hash,secret_hash,user_id,session_hash,token_hash,token,device_slot,app_version,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${active} RETURNING id`).bind(id,installationHash,secretHash,user.id,user.token_hash,tokenHash,token,slot,b.appVersion??null,time,time,user.token_hash,user.id,time);
  let results;
  try{
    // This row lock serializes registration with logout in the same transaction.
    results=await env.DB.batch([env.DB.prepare('UPDATE sessions SET token_hash=token_hash WHERE token_hash=? AND user_id=? AND expires_at>? AND revoked_at IS NULL RETURNING token_hash').bind(user.token_hash,user.id,time),statement]);
  }catch(error){if(/UNIQUE/i.test(error.message))fail(409,'device_conflict','Регистрация устройства изменилась. Повторите попытку.');throw error;}
  if(!results[0].results?.length)fail(401,'unauthorized','Сессия закончилась. Войдите снова.');
  if(!results[1].results?.length)fail(409,'device_conflict','Регистрация устройства изменилась. Повторите попытку.');
  return json({ok:true,deviceId:id,enabled:fcmConfigured(env)});
}
