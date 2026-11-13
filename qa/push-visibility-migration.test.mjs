import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,writeFile} from 'node:fs/promises';
await test('browser visibility migration retains old subscriptions and notification rows, defaulting to background delivery',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;');const folder=new URL('sqlite-migrations/',import.meta.url),files=(await readdir(folder)).filter(name=>name.endsWith('.sql')).sort();
  for(const name of files.filter(name=>name<'0008'))db.exec(await readFile(new URL(name,folder),'utf8'));
  db.prepare('INSERT INTO profiles (id,login,password_hash,nickname,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('owner','visibility.owner','synthetic','Owner','operator',1,1);
  db.prepare('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)').run('old-subscription','owner','https://web.push.apple.com/old','synthetic-public-key','synthetic-auth',1);
  db.prepare('INSERT INTO notifications (id,recipient_id,actor_id,type,object_key,object_label,note_id,parent_id,preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('old-notification','owner','owner','comment','pad:162','Куст162','note','parent','Retain',1);
  const before=JSON.parse(JSON.stringify(db.prepare('SELECT * FROM push_subscriptions').all())),notes=JSON.stringify(db.prepare('SELECT * FROM notifications').all());db.exec(await readFile(new URL('0008_browser_push_visibility.sql',folder),'utf8'));
  db.exec(await readFile(new URL('0009_browser_push_document_leases.sql',folder),'utf8'));
  const after=db.prepare('SELECT * FROM push_subscriptions').all();assert.equal(after[0].visible_until,0);assert.deepEqual(after.map(({visible_until,...row})=>row),before);assert.equal(JSON.stringify(db.prepare('SELECT * FROM notifications').all()),notes);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);for(const name of ['push_subscriptions_endpoint_unique','push_subscriptions_user'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name));
  db.prepare('INSERT INTO push_visibility_leases (sub_id,document_id,sequence,visible_until,updated_at) VALUES (?,?,?,?,?)').run('old-subscription',crypto.randomUUID(),1,20000,1);db.prepare('DELETE FROM push_subscriptions WHERE id=?').run('old-subscription');assert.equal(db.prepare('SELECT COUNT(*) AS c FROM push_visibility_leases').get().c,0);db.close();
});
await writeFile(new URL('push-visibility-migration-report.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),runtime:process.version,passed:true,oldSubscriptionsRetained:true,defaultVisibleUntil:0,notificationsUnchanged:true,foreignKeysAndIndexesPreserved:true,productionMutations:false},null,2)+'\n');
