import {first} from './core.mjs';
const OFFSET=5*3600000,DAY=86400000;
const dateText=time=>new Date(time).toISOString().slice(0,10);
function context(year,month,round,time){
  const start=[1,8,16,24][round-1],last=new Date(Date.UTC(year,month,0)).getUTCDate(),end=Math.min([7,15,23,30][round-1],last),startUtc=Date.UTC(year,month-1,start)-OFFSET,endUtc=Date.UTC(year,month-1,end+1)-OFFSET;
  const nextUtc=round<4?Date.UTC(year,month-1,[8,16,24][round-1])-OFFSET:Date.UTC(year,month,1)-OFFSET;
  return {key:`${year}-${String(month).padStart(2,'0')}:r${round}`,month:`${year}-${String(month).padStart(2,'0')}`,round,startDate:dateText(startUtc+OFFSET),endDate:dateText(endUtc+OFFSET-DAY),isBreak:time>=endUtc,timeZone:'Asia/Yekaterinburg',startsAt:new Date(startUtc).toISOString(),endsAt:new Date(endUtc).toISOString(),nextStartDate:dateText(nextUtc+OFFSET),nextStartsAt:new Date(nextUtc).toISOString(),asOf:new Date(time).toISOString()};
}
export function samplingPeriod(time){const local=new Date(time+OFFSET),day=local.getUTCDate(),round=day<=7?1:day<=15?2:day<=23?3:4;return context(local.getUTCFullYear(),local.getUTCMonth()+1,round,time);}
export function periodFromKey(key){const m=typeof key==='string'&&key.match(/^(\d{4})-(0[1-9]|1[0-2]):r([1-4])$/);if(!m)return null;const time=Date.UTC(Number(m[1]),Number(m[2])-1,[1,8,16,24][Number(m[3])-1])-OFFSET;return context(Number(m[1]),Number(m[2]),Number(m[3]),time);}
export async function currentSamplingPeriod(env){const row=await first(env,'SELECT atlas_now_ms() AS time,(SELECT COUNT(*) FROM sample_round_events) AS clockAnchor');return samplingPeriod(Number(row.time));}
export const periodStart=period=>Date.parse(period.startsAt);
export const periodEnd=period=>Date.parse(period.endsAt);
