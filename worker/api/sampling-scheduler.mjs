import {all,first,run,fail,json,uuid,base64url,bodyJson,ownKeys} from './core.mjs';
import {currentSamplingPeriod,periodStart,periodEnd} from './sampling-periods.mjs';

async function authorized(request,env,path){
  const secret=env.SAMPLING_CRON_SECRET,provided=request.headers.get('X-Atlas-Scheduler'),timestamp=request.headers.get('X-Atlas-Scheduler-Time');
  if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(secret)||typeof provided!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(provided)||typeof timestamp!=='string'||!/^\d{10,16}$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp)))return false;
  const clock=Number((await first(env,'SELECT atlas_now_ms() AS time,(SELECT COUNT(*) FROM sample_round_events) AS clockAnchor')).time),age=clock-Number(timestamp);if(age>120000||age< -30000)return false;
  const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']),expected=base64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(request.method+'\n'+path+'\n'+timestamp))));
  let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^provided.charCodeAt(i);return diff===0;
}
function preview(period){const short=date=>date.slice(8,10)+'.'+date.slice(5,7);return `Начался ${period.round}-й круг отбора проб: ${short(period.startDate)}–${short(period.endDate)}.${period.month.slice(0,4)}.`;}
function retryable(result){return Array.isArray(result)?result.some(r=>r.status==='rejected'||r.status==='fulfilled'&&Number(r.value?.retryable)>0):Number(result?.retryable)>0;}
async function dispatchBatch(env,period,leaseToken,cursor,retryJson,hooks){
  const parsed=JSON.parse(retryJson??'[]');if(!Array.isArray(parsed))throw Error('Invalid scheduler retry state');
  const queue=new Map(parsed.map(entry=>[entry.id,entry])),time=Date.parse(period.asOf);
  const persist=()=>env.DB.prepare('UPDATE sample_round_events SET dispatch_cursor=?,retry_ids=?,lease_until=atlas_now_ms()+120000 WHERE period_key=? AND lease_token=? RETURNING period_key').bind(cursor,JSON.stringify([...queue.values()]),period.key,leaseToken).run();
  const attempt=async row=>{try{return retryable(await hooks.sendPush?.(env,[row.recipient_id],{type:'sampling-round',notificationId:row.id,objectKey:'sampling',periodKey:period.key,title:'Новый круг отбора проб',body:preview(period)}));}catch{return true;}};
  let rows=await all(env,'SELECT id,recipient_id,seq FROM notifications WHERE round_key=? AND type=? AND seq>? ORDER BY seq LIMIT 20',period.key,'sampling-round',cursor),isRetry=false;
  if(!rows.length){
    const due=[...queue.values()].filter(entry=>entry.nextAt<=time).slice(0,20);isRetry=true;
    if(due.length){rows=await all(env,`SELECT id,recipient_id,seq FROM notifications WHERE round_key=? AND type=? AND id IN (${due.map(()=>'?').join(',')}) ORDER BY seq`,period.key,'sampling-round',...due.map(entry=>entry.id));const found=new Set(rows.map(r=>r.id));for(const entry of due)if(!found.has(entry.id))queue.delete(entry.id);}
  }
  for(let offset=0;offset<rows.length;offset+=5){
    const group=rows.slice(offset,offset+5),results=await Promise.all(group.map(attempt));
    for(let i=0;i<group.length;i++){
      const id=group[i].id,attempts=isRetry?(queue.get(id)?.attempt??1)+1:1;
      if(results[i]&&attempts<3)queue.set(id,{id,attempt:attempts,nextAt:time+60000*2**(attempts-1)});else queue.delete(id);
    }
    if(!isRetry)cursor=group.at(-1).seq;
    if(!(await persist()).results?.length)return;
  }
  const more=await first(env,'SELECT id FROM notifications WHERE round_key=? AND type=? AND seq>? LIMIT 1',period.key,'sampling-round',cursor),nextAttempt=more?0:queue.size?Math.min(...[...queue.values()].map(entry=>entry.nextAt)):0;
  await run(env,`UPDATE sample_round_events SET retry_ids=?,lease_token=NULL,lease_until=?${more||queue.size?'':',completed_at=atlas_now_ms()'} WHERE period_key=? AND lease_token=?`,JSON.stringify([...queue.values()]),nextAttempt,period.key,leaseToken);
}
export async function handleSamplingScheduler(request,env,path,ctx,hooks={}){
  if(path!=='/internal/sampling-round')return null;
  if(request.method!=='POST')fail(405,'method_not_allowed','Недопустимый запрос.');
  if(!await authorized(request,env,path))fail(401,'unauthorized','Доступ запрещён.');
  if(request.body){const body=await bodyJson(request);ownKeys(body,[]);}
  const period=await currentSamplingPeriod(env),time=Date.parse(period.asOf),mutation=uuid(),start=periodStart(period),end=periodEnd(period);
  // Establish a quiet baseline, without announcing the current circle retroactively.
  const bootstrap=await env.DB.prepare('INSERT INTO sample_round_events (period_key,starts_at,ends_at,created_at,mutation_id,completed_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sample_round_events) ON CONFLICT(period_key) DO NOTHING RETURNING period_key').bind(period.key,start,end,time,mutation,time).run();
  if(bootstrap.results?.length)return json({ok:true,bootstrap:true,created:0,period});
  await run(env,'UPDATE sample_round_events SET completed_at=atlas_now_ms(),lease_token=NULL,lease_until=0 WHERE period_key IN (SELECT period_key FROM sample_round_events WHERE completed_at IS NULL AND ends_at<=atlas_now_ms() LIMIT 16)');
  if(period.isBreak)return json({ok:true,created:0,period});
  const prefix='sr'+period.month.replace('-','')+'r'+period.round;
  const created=await env.DB.batch([
    env.DB.prepare('INSERT INTO sample_round_events (period_key,starts_at,ends_at,created_at,mutation_id) SELECT ?,?,?,?,? WHERE atlas_now_ms()>=? AND atlas_now_ms()<? ON CONFLICT(period_key) DO NOTHING RETURNING period_key').bind(period.key,start,end,time,mutation,start,end),
    env.DB.prepare("INSERT INTO notifications (id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at,round_key) SELECT ?||replace(p.id,'-',''),p.id,NULL,'sampling-round','sampling','Отбор проб',NULL,NULL,?,?,? FROM profiles p WHERE EXISTS (SELECT 1 FROM sample_round_events WHERE period_key=? AND mutation_id=?) ON CONFLICT(id) DO NOTHING RETURNING id").bind(prefix,preview(period),time,period.key,period.key,mutation)
  ]);
  const leaseToken=uuid(),claimed=await env.DB.prepare('UPDATE sample_round_events SET lease_token=?,lease_until=atlas_now_ms()+120000 WHERE period_key=? AND completed_at IS NULL AND lease_until<=atlas_now_ms() RETURNING dispatch_cursor,retry_ids').bind(leaseToken,period.key).run();
  if(claimed.results?.length){const task=dispatchBatch(env,period,leaseToken,Number(claimed.results[0].dispatch_cursor),claimed.results[0].retry_ids,hooks);if(ctx?.waitUntil)ctx.waitUntil(task.catch(()=>console.error('Sampling scheduler delivery failed')));else await task;}
  return json({ok:true,bootstrap:false,created:created[1].results?.length??0,scheduled:!!claimed.results?.length,period});
}
