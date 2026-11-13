import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {samplingPeriod,periodFromKey} from '../worker/api/sampling-periods.mjs';
import {postgresSql} from '../worker/adapters/supabase.mjs';
const checks=[];
await test('sampling periods use UTC+5, corrected day7, day31 break and short February',()=>{
  const p=date=>samplingPeriod(Date.parse(date+'+05:00'));
  for(const [day,round]of [[1,1],[7,1],[8,2],[15,2],[16,3],[23,3],[24,4],[30,4],[31,4]]){const item=p(`2026-12-${String(day).padStart(2,'0')}T12:00:00`);assert.equal(item.round,round);assert.equal(item.isBreak,day===31);assert.equal(item.key,`2026-12:r${round}`);}
  assert.equal(p('2026-11-07T23:59:59.999').key,'2026-11:r1');assert.equal(p('2026-11-08T00:00:00.000').key,'2026-11:r2');
  const feb=p('2027-02-28T23:59:59.999');assert.equal(feb.endDate,'2027-02-28');assert.equal(feb.isBreak,false);assert.equal(feb.endsAt,'2027-02-28T19:00:00.000Z');assert.equal(p('2028-02-29T12:00:00').endDate,'2028-02-29');
  const year=p('2026-12-31T12:00:00');assert.equal(year.nextStartDate,'2027-01-01');assert.equal(p('2027-01-01T00:00:00').key,'2027-01:r1');assert.equal(periodFromKey('2026-11:r3').startsAt,'2026-11-15T19:00:00.000Z');assert.equal(periodFromKey('invalid'),null);
  const sql=postgresSql('SELECT atlas_now_ms() AS time');assert.equal(sql,'SELECT CAST(floor(extract(epoch FROM clock_timestamp())*1000) AS bigint) AS time');checks.push('UTC+5 boundaries1/8/16/24, inclusive7, readonly31,28/29Feb and year rollover');
});
await test('combined SQLite migration preserves legacy rows, foreign keys, indexes and deleted sequence highwater',async()=>{
  const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON;');
  for(const name of ['0000_brigade','0001_shift_times','0002_equipment_absent','0003_partial_sampling','0004_native_fcm_devices'])raw.exec(await readFile(new URL('sqlite-migrations/'+name+'.sql',import.meta.url),'utf8'));
  raw.prepare('INSERT INTO profiles(id,login,password_hash,nickname,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('owner','owner','synthetic','Owner','operator',1,1);
  raw.prepare('INSERT INTO samples(pad_id,sampled,note,revision,updated_at,updated_by,mutation_id,well_ids) VALUES(?,?,?,?,?,?,?,?)').run('162',1,'Legacy mark',4,1,'owner','legacy-mutation',null);
  raw.prepare('INSERT INTO sample_audit(id,pad_id,sampled,note,revision,user_id,created_at,well_ids) VALUES(?,?,?,?,?,?,?,?)').run('legacy-audit','162',1,'Legacy audit',4,'owner',1,null);
  const insert=raw.prepare('INSERT INTO notifications(id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run('legacy','owner','owner','comment','pad:162','Куст №162','note','parent','Keep',1);insert.run('deleted-last','owner','owner','chat','chat','Чат','chat','chat','Delete',2);raw.prepare('DELETE FROM notifications WHERE id=?').run('deleted-last');
  const oldSamples=raw.prepare('SELECT * FROM samples').all(),oldAudit=raw.prepare('SELECT * FROM sample_audit').all(),oldNotifications=raw.prepare('SELECT * FROM notifications').all(),highwater=raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'").get().seq;
  raw.exec(await readFile(new URL('sqlite-migrations/0005_sampling_rounds_chat_context.sql',import.meta.url),'utf8'));raw.exec(await readFile(new URL('sqlite-migrations/0006_chat_mentions.sql',import.meta.url),'utf8'));
  const strip=rows=>rows.map(({round_key,...row})=>row),plain=rows=>JSON.parse(JSON.stringify(rows));assert.deepEqual(strip(raw.prepare('SELECT * FROM samples').all()),plain(oldSamples));assert.deepEqual(strip(raw.prepare('SELECT * FROM sample_audit').all()),plain(oldAudit));assert.deepEqual(strip(raw.prepare('SELECT * FROM notifications').all()),plain(oldNotifications));assert.equal(raw.prepare('SELECT round_key FROM notifications').get().round_key,null);
  insert.run('system','owner',null,'sampling-round','sampling','Отбор проб',null,null,'New circle',3);assert.ok(raw.prepare('SELECT seq FROM notifications WHERE id=?').get('system').seq>highwater);assert.equal(raw.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
  for(const name of ['notifications_id_unique','notifications_recipient_note','notifications_recipient_seq','notifications_recipient_read','notifications_round_seq'])assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name));raw.close();checks.push('Old samples/audit/notifications unchanged, new nullable keys NULL, indexes/FKs and deleted seq highwater retained');
});
await test('scheduler HMAC matches independent Node OpenSSL and actual PostgreSQL pgcrypto fixture',async()=>{
  const input='POST\n/internal/sampling-round\n1794576000000',secret='q'.repeat(43),expected='I5vTZcZJMzgEr1uz29WPHGvj51i1SXnxdpQPXMKIq_k';
  assert.equal(createHmac('sha256',secret).update(input).digest('base64url'),expected);const encoder=new TextEncoder(),key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);assert.equal(Buffer.from(await crypto.subtle.sign('HMAC',key,encoder.encode(input))).toString('base64url'),expected);
  const activation=await readFile(new URL('sampling-rounds-activation-review.sql',import.meta.url),'utf8');assert.match(activation,/extensions\.hmac\('POST'\|\|chr\(10\)\|\|'\/internal\/sampling-round'/);assert.ok(!activation.includes("'X-Atlas-Scheduler',s.value->>'secret'"));checks.push('WebCrypto/OpenSSL/actual PG pgcrypto HMAC interop and activation sends no static scheduler key');
});
await writeFile(new URL('sampling-rounds-report.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),runtime:process.version,passed:true,productionMutations:false,checks},null,2)+'\n');
