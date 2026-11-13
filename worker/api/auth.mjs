import {all,first,run,fail,now,iso,uuid,json,text,choice,integer,ownKeys,bodyJson,sha256,base64url,unbase64url,publicUser,rateLimit,clientIp} from './core.mjs';
export const PASSWORD_ITERATIONS=100000;
const encoder=new TextEncoder();
export async function passwordHash(password,salt=crypto.getRandomValues(new Uint8Array(16))) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:PASSWORD_ITERATIONS,hash:'SHA-256'},key,256);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
}
export async function passwordMatches(password,stored) {
  const parts=stored?.split('$'); if(parts?.length!==4 || parts[0]!=='pbkdf2-sha256' || Number(parts[1])!==PASSWORD_ITERATIONS) return false;
  let candidate; try { candidate=await passwordHash(password,unbase64url(parts[2])); } catch { return false; }
  const a=encoder.encode(candidate),b=encoder.encode(stored); let diff=a.length^b.length; for(let i=0;i<a.length;i++) diff|=a[i]^(b[i]??0); return diff===0;
}
function loginValue(value) { const v=text(value,'login',3,40).toLowerCase(); if(!/^[a-z0-9][a-z0-9._-]*$/.test(v)) fail(400,'invalid_login','Логин: 3–40 латинских букв, цифр, точек, дефисов или подчёркиваний.'); return v; }
function passwordValue(value) { if(typeof value!=='string' || value.length<10 || value.length>128 || encoder.encode(value).length>512) fail(400,'invalid_password','Пароль должен содержать от 10 до 128 символов.'); return value; }
function profileFields(body,partial=false) {
  const out={};
  if(!partial || 'nickname' in body) out.nickname=text(body.nickname,'nickname',2,60);
  if(!partial || 'position' in body) out.position=choice(body.position,'position',['operator','master']);
  if(!partial || 'grade' in body) out.grade=body.grade==null?null:integer(body.grade,'grade',3,6);
  return out;
}
async function issueSession(env,user,request,remember=true) {
  const ttl=remember?30*86400:86400;
  const token=base64url(crypto.getRandomValues(new Uint8Array(32))),hash=await sha256(token),time=now(),expires=time+ttl*1000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND (expires_at < ? OR revoked_at IS NOT NULL)').bind(user.id,time),
    env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').bind(hash,user.id,time,expires),
    env.DB.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 10)').bind(user.id)
  ]);
  const headers={};
  // Cookies are optional and same-origin only; the app normally uses bearer tokens.
  if(new URL(request.url).protocol==='https:' && (!request.headers.get('Origin') || request.headers.get('Origin')===new URL(request.url).origin)) headers['Set-Cookie']=`atlas_session=${token}; Path=${env.COOKIE_PATH??'/api/v1'}; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
  return json({user:publicUser(user),token,expiresAt:iso(expires)},200,headers);
}
export async function requireUser(request,env) {
  let token; const auth=request.headers.get('Authorization');
  if(auth) { if(!auth.startsWith('Bearer ')) fail(401,'unauthorized','Войдите в приложение.'); token=auth.slice(7); }
  else { token=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('atlas_session='))?.slice(14); }
  if(!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401,'unauthorized','Войдите в приложение.');
  const hash=await sha256(token);
  const user=await first(env,'SELECT p.*,s.token_hash FROM sessions s JOIN profiles p ON p.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL',hash,now());
  if(!user) fail(401,'unauthorized','Сессия закончилась. Войдите снова.'); return user;
}
export async function handleAuth(request,env,path) {
  if(path==='/auth/register' && request.method==='POST') {
    await rateLimit(env,`register-ip:${clientIp(request,env)}`,30,3600);
    const b=await bodyJson(request); ownKeys(b,['login','password','nickname','position','grade','remember']);
    if('remember' in b && typeof b.remember!=='boolean') fail(400,'invalid_input','Недопустимое поле remember.');
    const login=loginValue(b.login),password=passwordValue(b.password),fields=profileFields(b),time=now();
    if(await first(env,'SELECT id FROM profiles WHERE login=?',login)) fail(409,'login_taken','Этот логин уже занят.');
    const user={id:uuid(),login,password_hash:await passwordHash(password),nickname:fields.nickname,position:fields.position,grade:fields.grade,avatar_media_id:null,created_at:time,updated_at:time};
    try { await run(env,'INSERT INTO profiles (id,login,password_hash,nickname,position,grade,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',user.id,login,user.password_hash,user.nickname,user.position,user.grade,time,time); }
    catch(error) { if(/UNIQUE/i.test(error.message)) fail(409,'login_taken','Этот логин уже занят.'); throw error; }
    return issueSession(env,user,request,b.remember!==false);
  }
  if(path==='/auth/login' && request.method==='POST') {
    await rateLimit(env,`login-ip:${clientIp(request,env)}`,20,900);
    const b=await bodyJson(request); ownKeys(b,['login','password','remember']); if('remember' in b && typeof b.remember!=='boolean') fail(400,'invalid_input','Недопустимое поле remember.'); const login=loginValue(b.login),password=passwordValue(b.password);
    await rateLimit(env,`login-account:${login}`,10,900);
    const user=await first(env,'SELECT * FROM profiles WHERE login=?',login);
    // An unknown login incurs the same KDF work as a known account.
    const stored=user?.password_hash??`pbkdf2-sha256$${PASSWORD_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const valid=await passwordMatches(password,stored);
    if(!user || !valid) fail(401,'invalid_credentials','Неверный логин или пароль.'); return issueSession(env,user,request,b.remember!==false);
  }
  return null;
}
export async function handleProfile(request,env,path,user) {
  if(path==='/auth/logout' && request.method==='POST') {
    await run(env,'UPDATE sessions SET revoked_at=? WHERE token_hash=?',now(),user.token_hash);
    return json({ok:true},200,{'Set-Cookie':`atlas_session=; Path=${env.COOKIE_PATH??'/api/v1'}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});
  }
  if(path==='/me' && request.method==='GET') return json({user:publicUser(user)});
  if(path==='/me' && request.method==='PATCH') {
    const b=await bodyJson(request); ownKeys(b,['nickname','position','grade','avatarMediaId']); const fields=profileFields(b,true);
    if('avatarMediaId' in b) {
      if(b.avatarMediaId===null) fields.avatar_media_id=null;
      else { const id=text(b.avatarMediaId,'avatarMediaId',1,64); if(!await first(env,'SELECT id FROM media WHERE id=? AND owner_id=?',id,user.id)) fail(400,'invalid_media','Изображение не найдено.'); fields.avatar_media_id=id; }
    }
    if(!Object.keys(fields).length) fail(400,'empty_update','Нет изменений.'); fields.updated_at=now();
    const columns=Object.keys(fields); await run(env,`UPDATE profiles SET ${columns.map(c=>`${c}=?`).join(',')} WHERE id=?`,...columns.map(c=>fields[c]),user.id);
    return json({user:publicUser(await first(env,'SELECT * FROM profiles WHERE id=?',user.id))});
  }
  if(path==='/profiles' && request.method==='GET') {
    const url=new URL(request.url),limit=url.searchParams.has('limit')?integer(Number(url.searchParams.get('limit')),'limit',1,100):100;
    const cursor=url.searchParams.get('after')??''; if(cursor.length>64) fail(400,'invalid_cursor','Некорректный курсор.');
    const rows=await all(env,'SELECT id,login,nickname,position,grade,avatar_media_id,created_at,updated_at FROM profiles WHERE id>? ORDER BY id LIMIT ?',cursor,limit+1);
    const more=rows.length>limit; if(more)rows.pop(); return json({items:rows.map(publicUser),nextCursor:more?rows.at(-1)?.id:null});
  }
  return null;
}
