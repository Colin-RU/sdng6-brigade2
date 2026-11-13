import {all,first,run,fail,now,iso,uuid,json,text,choice,integer,boolean,ownKeys,bodyJson,authorFrom} from './core.mjs';
import {padId,objectKey,padIds} from '../registry.mjs';
const authorCols='p.login,p.nickname,p.position,p.grade,p.avatar_media_id';
function stateView(row,pad=null) {
  if(!row)return pad?{padId:pad,sampled:false,revision:0,updatedAt:null,author:null,note:''}:{status:'unknown',revision:0,updatedAt:null,author:null,note:''};
  return {...(pad?{padId:pad,sampled:!!row.sampled}:{status:row.status}),revision:row.revision,updatedAt:iso(row.updated_at),author:authorFrom(row),note:row.note};
}
async function sampleGet(env,id){return first(env,`SELECT s.*,s.updated_by AS user_id,${authorCols} FROM samples s JOIN profiles p ON p.id=s.updated_by WHERE s.pad_id=?`,id);}
async function statusGet(env,key){return first(env,`SELECT s.*,s.updated_by AS user_id,${authorCols} FROM object_statuses s JOIN profiles p ON p.id=s.updated_by WHERE s.object_key=?`,key);}
async function updateState(request,env,user,id,isSample) {
  const b=await bodyJson(request);ownKeys(b,isSample?['sampled','revision','note']:['status','revision','note']);
  const revision=integer(b.revision,'revision',0,2147483646),value=isSample?(boolean(b.sampled,'sampled')?1:0):choice(b.status,'status',['unknown','ok','attention','stopped']);
  const note=text(b.note??'','note',0,1000),time=now(),mutationId=uuid();
  const table=isSample?'samples':'object_statuses',key=isSample?'pad_id':'object_key',column=isSample?'sampled':'status',audit=isSample?'sample_audit':'status_audit';
  const change=revision===0?
    env.DB.prepare(`INSERT INTO ${table} (${key},${column},note,revision,updated_at,updated_by,mutation_id) VALUES (?,?,?,1,?,?,?) ON CONFLICT(${key}) DO NOTHING RETURNING *`).bind(id,value,note,time,user.id,mutationId):
    env.DB.prepare(`UPDATE ${table} SET ${column}=?,note=?,revision=revision+1,updated_at=?,updated_by=?,mutation_id=? WHERE ${key}=? AND revision=? RETURNING *`).bind(value,note,time,user.id,mutationId,id,revision);
  const results=await env.DB.batch([change,env.DB.prepare(`INSERT INTO ${audit} (id,${key},${column},note,revision,user_id,created_at) SELECT mutation_id,${key},${column},note,revision,updated_by,updated_at FROM ${table} WHERE ${key}=? AND mutation_id=?`).bind(id,mutationId)]);
  if(!results[0].results?.length)fail(409,'revision_conflict','Данные уже изменены. Обновите их.',{current:stateView(isSample?await sampleGet(env,id):await statusGet(env,id),isSample?id:null)});
  const item=stateView(isSample?await sampleGet(env,id):await statusGet(env,id),isSample?id:null);return json(isSample?{item}:item);
}
function dateValue(value,name){const v=text(value,name,10,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail(400,'invalid_date','Некорректная дата.');return v;}
const shiftView=row=>({id:row.id,date:row.date,kind:row.kind,startAt:iso(row.start_at),endAt:iso(row.end_at),note:row.note,author:authorFrom(row),createdAt:iso(row.created_at)});
export async function handleField(request,env,path,user) {
  const url=new URL(request.url);let m;
  if(path==='/samples'&&request.method==='GET') {
    const id=url.searchParams.get('padId');if(id!==null)padId(id);
    const rows=await all(env,`SELECT s.*,s.updated_by AS user_id,${authorCols} FROM samples s JOIN profiles p ON p.id=s.updated_by${id?' WHERE s.pad_id=?':''}`,...(id?[id]:[]));
    const byPad=new Map(rows.map(r=>[r.pad_id,r]));return json({items:(id?[id]:padIds).map(p=>stateView(byPad.get(p),p))});
  }
  m=path.match(/^\/samples\/([^/]+)$/);if(m&&request.method==='PUT')return updateState(request,env,user,padId(decodeURIComponent(m[1])),true);
  m=path.match(/^\/objects\/([^/]+)\/status$/);
  if(m){const key=objectKey(decodeURIComponent(m[1]));if(request.method==='GET')return json(stateView(await statusGet(env,key)));if(request.method==='PUT')return updateState(request,env,user,key,false);}
  if(path==='/shifts'&&request.method==='GET') {
    const from=dateValue(url.searchParams.get('from'),'from'),to=dateValue(url.searchParams.get('to'),'to');if(to<from||Date.parse(to)-Date.parse(from)>93*86400000)fail(400,'date_range','Период должен быть не больше 93 дней.');
    const rows=await all(env,`SELECT s.*,${authorCols} FROM shifts s JOIN profiles p ON p.id=s.user_id WHERE s.date>=? AND s.date<=? ORDER BY s.date,s.kind,s.id LIMIT 1001`,from,to);
    if(rows.length>1000)fail(400,'date_range','Выберите меньший период.');return json({items:rows.map(shiftView),nextCursor:null});
  }
  if(path==='/shifts'&&request.method==='POST') {
    const b=await bodyJson(request);ownKeys(b,['date','kind','note','startAt','endAt']);const date=dateValue(b.date,'date'),kind=choice(b.kind,'kind',['day','night']),note=text(b.note??'','note',0,500),id=uuid();
    let start=null,end=null;
    if(b.startAt!=null||b.endAt!=null){
      const startText=text(b.startAt,'startAt',20,35),endText=text(b.endAt,'endAt',20,35);if(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(startText)||!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(endText))fail(400,'invalid_date','Укажите время с часовым поясом.');
      start=Date.parse(startText);end=Date.parse(endText);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>36*3600000||new Date(start+5*3600000).toISOString().slice(0,10)!==date)fail(400,'invalid_shift','Проверьте начало и конец смены (часовой пояс Сургута, не более 36 часов).');
    }
    await run(env,'INSERT INTO shifts (id,user_id,date,kind,note,created_at,start_at,end_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,date,kind) DO UPDATE SET note=excluded.note,start_at=excluded.start_at,end_at=excluded.end_at',id,user.id,date,kind,note,now(),start,end);
    const row=await first(env,`SELECT s.*,${authorCols} FROM shifts s JOIN profiles p ON p.id=s.user_id WHERE s.user_id=? AND s.date=? AND s.kind=?`,user.id,date,kind);return json({item:shiftView(row)},row.id===id?201:200);
  }
  m=path.match(/^\/shifts\/([A-Za-z0-9-]{1,64})$/);
  if(m&&request.method==='DELETE'){const row=await first(env,'SELECT user_id FROM shifts WHERE id=?',m[1]);if(!row)fail(404,'not_found','Смена не найдена.');if(row.user_id!==user.id)fail(403,'forbidden','Можно удалять только свои смены.');await run(env,'DELETE FROM shifts WHERE id=? AND user_id=?',m[1],user.id);return json({ok:true});}
  return null;
}
