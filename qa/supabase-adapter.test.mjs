import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SupabaseD1,SupabaseBucket,postgresSql} from '../worker/adapters/supabase.mjs';
import {currentSamplingPeriod} from '../worker/api/sampling-periods.mjs';
import {handleSamplingScheduler} from '../worker/api/sampling-scheduler.mjs';
await test('server SQL adapter qualifies schema and keeps hostile values out of SQL',async()=>{
  const calls=[],secret='server-only-test-key',fetcher=async(url,options)=>{calls.push({url,options});return Response.json([{success:true,results:[{id:'result'}],meta:{changes:1}}]);};
  const db=new SupabaseD1('https://example.supabase.co',secret,fetcher),input="What? '); DROP TABLE profiles; --";
  assert.equal((await db.prepare('SELECT * FROM profiles WHERE nickname=?').bind(input).first()).id,'result');
  const request=JSON.parse(calls[0].options.body);assert.equal(request.commands[0].sql,'SELECT * FROM brigade."profiles" WHERE nickname=?');assert.equal(request.commands[0].params[0],input);assert.ok(!request.commands[0].sql.includes(input));assert.equal(calls[0].options.headers.Authorization,'Bearer '+secret);
  assert.equal(postgresSql('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions LIMIT -1 OFFSET 10)'),'DELETE FROM brigade."sessions" WHERE token_hash IN (SELECT token_hash FROM brigade."sessions" LIMIT ALL OFFSET 10)');
  assert.ok(postgresSql('SELECT * FROM media WHERE id IN (SELECT value FROM json_each(?))').includes('jsonb_array_elements_text(?::jsonb)'));
});
await test('private storage adapter authenticates requests and encodes object paths',async()=>{
  const calls=[],bucket=new SupabaseBucket('https://example.supabase.co','server-key','brigade-media',async(url,options)=>{calls.push({url,options});return new Response('image',{status:200});});
  await bucket.put('images/user/photo id',new Uint8Array([1,2]),{httpMetadata:{contentType:'image/png'}});assert.match(calls[0].url,/brigade-media\/images\/user\/photo%20id$/);assert.equal(calls[0].options.headers['x-upsert'],'false');assert.equal(calls[0].options.headers.apikey,'server-key');
  assert.ok((await bucket.get('images/user/photo id')).body);await bucket.delete('images/user/photo id');assert.deepEqual(JSON.parse(calls[2].options.body),{prefixes:['images/user/photo id']});
});
await test('production SQL denies client roles and binds literals without reparsing them',async()=>{
  const ddl=await readFile(new URL('../supabase/migrations/202611130001_brigade.sql',import.meta.url),'utf8'),rpc=await readFile(new URL('../supabase/migrations/202611130002_api_rpc.sql',import.meta.url),'utf8');
  const tables=[...ddl.matchAll(/CREATE TABLE brigade\."?([a-z_]+)"?/g)].map(m=>m[1]);assert.equal(tables.length,14);for(const table of tables)assert.ok(new RegExp(`ALTER TABLE brigade\\."?${table}"? ENABLE ROW LEVEL SECURITY`).test(ddl),table);
  assert.match(rpc,/REVOKE ALL ON FUNCTION public\.brigade_query_batch\(jsonb\) FROM PUBLIC, anon, authenticated/);assert.match(rpc,/GRANT EXECUTE ON FUNCTION public\.brigade_query_batch\(jsonb\) TO service_role/);assert.match(rpc,/SET search_path = ''/);assert.match(rpc,/quote_literal\(parameter #>> '\{\}'\)/);assert.match(rpc,/strpos\(remaining_statement,'\?'\)/);assert.doesNotMatch(rpc,/SECURITY DEFINER/);
});
await test('actual sampling and HMAC clocks pass the unchanged production RPC schema guard',async()=>{
  const commands=[],time=Date.parse('2026-11-13T12:00:00+05:00'),DB=new SupabaseD1('https://example.supabase.co','synthetic-server-key',async(_url,options)=>{
    const batch=JSON.parse(options.body).commands;for(const command of batch){commands.push(command);assert.match(command.sql,/brigade\./,'production RPC rejects a bare SELECT clock without brigade schema');assert.match(command.sql,/FROM brigade\."sample_round_events"/);assert.deepEqual(command.params,[]);}
    return Response.json(batch.map(()=>({success:true,results:[{time,clockanchor:0}],meta:{changes:1}})));
  });
  assert.equal((await currentSamplingPeriod({DB})).key,'2026-11:r2');
  const request=new Request('https://example.supabase.co/api/v1/internal/sampling-round',{method:'POST',headers:{'X-Atlas-Scheduler-Time':String(time),'X-Atlas-Scheduler':'x'.repeat(43)},body:'{}'});
  await assert.rejects(()=>handleSamplingScheduler(request,{DB,SAMPLING_CRON_SECRET:'q'.repeat(43)},'/internal/sampling-round'),error=>error.status===401&&error.code==='unauthorized');assert.equal(commands.length,2,'both actual server clock callsites were qualified');
});
