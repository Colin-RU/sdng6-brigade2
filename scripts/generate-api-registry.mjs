import {readFile,writeFile,mkdir} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const data=JSON.parse(await readFile(new URL('docs/data.json',root),'utf8'));
const entries=Object.fromEntries(data.pads.map(p=>[String(p.id),[...new Set(p.wells.map(w=>String(w.id)))]]));
const positions={};
for(const pad of data.pads){
  if(pad.id==='ОД')continue;
  const wellIds=entries[pad.id],groups=pad.positions??[{id:1,label:'1-я позиция',wellIds}];
  if(!Array.isArray(groups)||!groups.length)throw Error(`Missing positions for ${pad.id}`);
  const assigned=new Map();
  for(const [index,group] of groups.entries()){
    if(!Number.isInteger(group.id)||group.id!==index+1||group.id>9||!Array.isArray(group.wellIds))throw Error(`Invalid position for ${pad.id}`);
    for(const id of group.wellIds){if(typeof id!=='string'||!wellIds.includes(id)||assigned.has(id))throw Error(`Invalid position well ${pad.id}:${id}`);assigned.set(id,group.id);}
  }
  if(assigned.size!==wellIds.length)throw Error(`Positions do not cover registry ${pad.id}`);
  for(const well of pad.wells)if(well.position!=null&&well.position!==assigned.get(String(well.id)))throw Error(`Position mismatch ${pad.id}:${well.id}`);
  positions[pad.id]=groups.map(p=>({id:p.id,label:p.label??`${p.id}-я позиция`}));
}
await mkdir(new URL('worker/',root),{recursive:true});
const output=`// Generated from the imported brigade registry; equipment keys do not assert physical presence.
import {fail} from './api/core.mjs';
export const registry=${JSON.stringify(entries,null,2)};
export const positionRegistry=${JSON.stringify(positions,null,2)};
export const padIds=Object.keys(positionRegistry);
export const equipmentKinds=['agzu','btma','bg','drainage','control-stations','cable-racks'];
export function padId(value) {
  if(typeof value!=='string'||!padIds.includes(value))fail(400,'unknown_pad','Куст не найден в реестре.');
  return value;
}
export function objectKey(value) {
  if(typeof value!=='string'||value.length>180)fail(400,'unknown_object','Объект не найден.');
  const parts=value.split(':');
  if(parts[0]==='pad'&&parts.length===2){padId(parts[1]);return value;}
  if(parts[0]==='well'&&parts.length===3&&Object.hasOwn(registry,parts[1])&&registry[parts[1]].includes(parts[2]))return value;
  if(parts[0]==='equipment'&&(parts.length===3||parts.length===4)){
    const pad=padId(parts[1]),groups=positionRegistry[pad],kind=parts.at(-1);
    if(!equipmentKinds.includes(kind))fail(400,'unknown_object','Оборудование не найдено в реестре.');
    const position=parts.length===3?1:(/^p[1-9]$/.test(parts[2])?Number(parts[2].slice(1)):0);
    if(!groups.some(p=>p.id===position))fail(400,'unknown_position','Позиция не найдена в реестре.');
    return groups.length===1?'equipment:'+pad+':'+kind:'equipment:'+pad+':p'+position+':'+kind;
  }
  fail(400,'unknown_object','Объект не найден в реестре.');
}
`;
await writeFile(new URL('worker/registry.mjs',root),output,'utf8');
console.log(`API registry: ${Object.keys(positions).length} pads + separate wells; ${Object.values(positions).filter(p=>p.length>1).length} pads with multiple positions`);
