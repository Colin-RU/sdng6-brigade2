import {first,all,run,fail,now,uuid,json,text,readBounded,rateLimit,iso,sha256} from './core.mjs';
const MAX_IMAGE=2*1024*1024;
function imageType(bytes) {
  if(bytes.length>=12 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return 'image/jpeg';
  if(bytes.length>=24 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n) && String.fromCharCode(...bytes.slice(12,16))==='IHDR') return 'image/png';
  if(bytes.length>=16 && String.fromCharCode(...bytes.slice(0,4))==='RIFF' && String.fromCharCode(...bytes.slice(8,12))==='WEBP') return 'image/webp';
  return null;
}
export const mediaView = row => ({id:row.id,mimeType:row.mime_type,size:row.size,createdAt:iso(row.created_at)});
export async function mediaForIds(env,ids,ownerId=null) {
  if(!Array.isArray(ids) || ids.length>3 || new Set(ids).size!==ids.length) fail(400,'invalid_media','Можно прикрепить до трёх разных изображений.');
  for(const id of ids)text(id,'mediaIds',1,64);
  if(!ids.length)return [];
  const rows=await all(env,`SELECT * FROM media WHERE id IN (${ids.map(()=>'?').join(',')})${ownerId?' AND owner_id=?':''}`,...ids,...(ownerId?[ownerId]:[]));
  if(rows.length!==ids.length)fail(400,'invalid_media','Изображение не найдено или загружено другим пользователем.');
  const map=new Map(rows.map(r=>[r.id,r])); return ids.map(id=>mediaView(map.get(id)));
}
export async function handleMedia(request,env,path,user) {
  if(path==='/media' && request.method==='POST') {
    await rateLimit(env,`media-user:${user.id}`,20,3600);
    const type=request.headers.get('Content-Type')??''; if(!/^multipart\/form-data\s*;/i.test(type))fail(415,'content_type','Загрузите изображение формой.');
    // Multipart framing has a separate bounded allowance; file bytes are capped below.
    const bytes=await readBounded(request,MAX_IMAGE+65536); let form;
    try { form=await new Response(bytes,{headers:{'Content-Type':type}}).formData(); } catch { fail(400,'invalid_upload','Не удалось прочитать файл.'); }
    if([...form.keys()].some(key=>!['file','clientId'].includes(key)) || form.getAll('file').length!==1 || form.getAll('clientId').length>1)fail(400,'invalid_upload','Нужно одно изображение в поле file.');
    const clientId=form.has('clientId')?text(form.get('clientId'),'clientId',8,80):null;if(clientId&&!/^[A-Za-z0-9_-]+$/.test(clientId))fail(400,'invalid_input','Некорректный clientId.');
    const file=form.get('file'); if(!file || typeof file==='string' || !file.size)fail(400,'invalid_upload','Выберите изображение.');
    if(file.size>MAX_IMAGE)fail(413,'too_large','Изображение должно быть не больше 2 МБ.');
    const data=new Uint8Array(await file.arrayBuffer()),mime=imageType(data);
    if(!mime || file.type.toLowerCase()!==mime)fail(415,'invalid_image','Поддерживаются JPEG, PNG и WebP.');
    const hash=await sha256(data);
    const existing=clientId?await first(env,'SELECT * FROM media WHERE owner_id=? AND client_id=?',user.id,clientId):null;
    if(existing){if(existing.content_hash!==hash||existing.mime_type!==mime)fail(409,'idempotency_conflict','Этот запрос уже использован для другого изображения.');return json({media:mediaView(existing),duplicate:true});}
    const id=uuid(),key=`images/${user.id}/${id}`,time=now();
    await env.BUCKET.put(key,data,{httpMetadata:{contentType:mime},customMetadata:{ownerId:user.id,mediaId:id}});
    try { await run(env,'INSERT INTO media (id,owner_id,bucket_key,mime_type,size,created_at,client_id,content_hash) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,client_id) DO NOTHING',id,user.id,key,mime,file.size,time,clientId,hash); }
    catch(error) { await env.BUCKET.delete(key); throw error; }
    if(clientId){const saved=await first(env,'SELECT * FROM media WHERE owner_id=? AND client_id=?',user.id,clientId);if(saved.id!==id){await env.BUCKET.delete(key);if(saved.content_hash!==hash||saved.mime_type!==mime)fail(409,'idempotency_conflict','Этот запрос уже использован для другого изображения.');return json({media:mediaView(saved),duplicate:true});}}
    return json({media:{id,mimeType:mime,size:file.size,createdAt:iso(time)}},201);
  }
  const m=path.match(/^\/media\/([A-Za-z0-9-]{1,64})$/);
  if(m && request.method==='DELETE') {
    const row=await first(env,'SELECT * FROM media WHERE id=?',m[1]);if(!row)fail(404,'not_found','Изображение не найдено.');
    if(row.owner_id!==user.id)fail(403,'forbidden','Можно удалять только свои изображения.');
    // Media IDs are server-generated UUIDs. Quoted UUID matching is exact inside
    // the stored JSON arrays, regardless of their optional whitespace.
    const pattern='%'+JSON.stringify(row.id)+'%';
    const removed=await first(env,`DELETE FROM media WHERE id=? AND owner_id=? AND NOT EXISTS (SELECT 1 FROM profiles WHERE avatar_media_id=?) AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE media_ids LIKE ?) AND NOT EXISTS (SELECT 1 FROM object_notes WHERE media_ids LIKE ?) RETURNING *`,row.id,user.id,row.id,pattern,pattern);
    if(!removed)fail(409,'media_in_use','Изображение используется в профиле или записи. Сначала уберите его оттуда.');
    try { await env.BUCKET.delete(removed.bucket_key); }
    catch(error) {
      // A storage failure must leave the media discoverable for an owner retry.
      await run(env,'INSERT INTO media (id,owner_id,bucket_key,mime_type,size,created_at,client_id,content_hash) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',removed.id,removed.owner_id,removed.bucket_key,removed.mime_type,removed.size,removed.created_at,removed.client_id,removed.content_hash);
      throw error;
    }
    return json({ok:true});
  }
  if(m && request.method==='GET') {
    // Shared brigade images are readable only after authentication; upload ownership
    // is enforced whenever an image is attached to a new message/note/avatar.
    const row=await first(env,'SELECT * FROM media WHERE id=?',m[1]); if(!row)fail(404,'not_found','Изображение не найдено.');
    const object=await env.BUCKET.get(row.bucket_key); if(!object)fail(404,'not_found','Изображение не найдено.');
    return new Response(object.body,{headers:{'Content-Type':row.mime_type,'Content-Length':String(row.size),'Content-Disposition':'inline','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
  return null;
}
