export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, {status, code, details}); }
}
export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export const now = () => Date.now();
export const iso = value => value == null ? null : new Date(value).toISOString();
export const uuid = () => crypto.randomUUID();
export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...headers}});
export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results ?? [];
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
export function text(value, name, min = 0, max = 2000) {
  if (typeof value !== 'string') fail(400,'invalid_input',`Поле ${name} должно быть текстом.`);
  const v = value.trim();
  if (v.length < min || v.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(v)) fail(400,'invalid_input',`Недопустимое поле ${name}.`);
  return v;
}
export function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(400,'invalid_input',`Недопустимое поле ${name}.`);
  return value;
}
export function choice(value, name, values) { if (!values.includes(value)) fail(400,'invalid_input',`Недопустимое поле ${name}.`); return value; }
export function boolean(value, name) { if (typeof value !== 'boolean') fail(400,'invalid_input',`Недопустимое поле ${name}.`); return value; }
export function ownKeys(value, keys) { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(400,'invalid_input',`Неизвестное поле ${key}.`); }
export async function readBounded(request, max) {
  const length = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > max) fail(413,'too_large','Слишком большой запрос.');
  if (!request.body) return new Uint8Array();
  const reader=request.body.getReader(); const chunks=[]; let size=0;
  try { while (true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>max) { await reader.cancel(); fail(413,'too_large','Слишком большой запрос.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks) { bytes.set(c,offset); offset+=c.length; } return bytes;
}
export async function bodyJson(request, max = 16384) {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) fail(415,'content_type','Нужен JSON-запрос.');
  let value; try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBounded(request,max))); } catch(error) { if(error instanceof ApiError) throw error; fail(400,'invalid_json','Не удалось прочитать запрос.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(400,'invalid_json','Нужен JSON-объект.'); return value;
}
const encoder=new TextEncoder();
export async function sha256(value) { const bytes=typeof value==='string'?encoder.encode(value):value; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''); }
export function base64url(bytes) { let s=''; for(const n of bytes)s+=String.fromCharCode(n); return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
export function unbase64url(value) { const s=atob(value.replaceAll('-','+').replaceAll('_','/')); return Uint8Array.from(s,c=>c.charCodeAt(0)); }
export const publicUser = row => ({id:row.id,login:row.login,nickname:row.nickname,position:row.position,grade:row.grade,avatarMediaId:row.avatar_media_id ?? null,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)});
export const authorFrom = row => ({id:row.user_id,login:row.login,nickname:row.nickname,position:row.position,grade:row.grade,avatarMediaId:row.avatar_media_id ?? null});
export function pageArgs(url) {
  const before=url.searchParams.get('before'),after=url.searchParams.get('after');
  if(before && after) fail(400,'invalid_cursor','Используйте только before или after.');
  for(const v of [before,after]) if(v && !/^[1-9]\d{0,14}$/.test(v)) fail(400,'invalid_cursor','Некорректный курсор.');
  const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50; integer(limit,'limit',1,50);
  return {before:before?Number(before):null,after:after?Number(after):null,limit};
}
export const allowedOrigins = new Set(['https://colin-ru.github.io','https://appassets.androidplatform.net','https://sdng6-brigade2-field-atlas.vasyiliy.chatgpt.site']);
export function originAllowed(request) {
  const origin=request.headers.get('Origin'); if(!origin) return true;
  if(origin===new URL(request.url).origin || allowedOrigins.has(origin)) return true;
  try { const u=new URL(origin); return ['http:','https:'].includes(u.protocol) && ['localhost','127.0.0.1','[::1]'].includes(u.hostname); } catch { return false; }
}
export function cors(request,response) {
  const headers=new Headers(response.headers); headers.set('Cache-Control','no-store'); headers.set('Vary','Origin');
  const origin=request.headers.get('Origin');
  if(origin && originAllowed(request)) { headers.set('Access-Control-Allow-Origin',origin); headers.set('Access-Control-Allow-Credentials','true'); }
  headers.set('Access-Control-Allow-Headers','Authorization, Content-Type'); headers.set('Access-Control-Allow-Methods','GET, POST, PATCH, PUT, DELETE, OPTIONS');
  headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','no-referrer');
  return new Response(response.body,{status:response.status,headers});
}
export async function rateLimit(env,key,limit,seconds) {
  const time=now(),window=Math.floor(time/(seconds*1000)),expires=(window+1)*seconds*1000;
  const hash=await sha256(`${key}:${window}`);
  const row=await first(env,`INSERT INTO rate_limits (key, count, expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count`,hash,expires);
  // Every invocation removes a bounded amount of expired data, never an unbounded sweep.
  await run(env,'DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT 32)',time);
  if(row.count>limit) fail(429,'rate_limited','Слишком много попыток. Попробуйте позже.',{retryAfter:Math.max(1,Math.ceil((expires-time)/1000))});
}
// Edge wrapper may supply a gateway-derived IP; no arbitrary forwarding header is trusted here.
export const clientIp = (request,env={}) => env.REQUEST_IP ?? request.headers.get('CF-Connecting-IP') ?? 'local';
