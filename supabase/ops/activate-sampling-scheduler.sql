-- Separate activation, only after the new Edge handler is deployed and reviewed.
-- Random256-bit scheduler credential stays entirely inside the private database.
INSERT INTO brigade.app_secrets(key,value)
VALUES ('sampling_scheduler',jsonb_build_object('secret',translate(rtrim(encode(extensions.gen_random_bytes(32),'base64'),'='),'+/','-_')))
ON CONFLICT(key) DO NOTHING;

-- The managed net queue may have public grants. It sees only timestamp+HMAC,
-- never this static private secret. A proof expires after120s and is method/path bound.
SELECT cron.schedule('brigade-sampling-rounds','* * * * *',$job$
WITH clock AS (
  SELECT clock_timestamp() AS moment
), local_clock AS (
  SELECT moment AT TIME ZONE 'Asia/Yekaterinburg' AS local_time,
    floor(extract(epoch FROM moment)*1000)::bigint::text AS signed_at FROM clock
), target AS (
  SELECT to_char(local_time,'YYYY-MM')||':r'||CASE
    WHEN extract(day FROM local_time)<=7 THEN '1'
    WHEN extract(day FROM local_time)<=15 THEN '2'
    WHEN extract(day FROM local_time)<=23 THEN '3' ELSE '4' END AS period_key,
    extract(day FROM local_time)=31 AS is_break,signed_at
  FROM local_clock
)
SELECT net.http_post(
  url:='https://ufwrdwndlzwxtlkougrv.supabase.co/functions/v1/brigade-api/internal/sampling-round',
  headers:=jsonb_build_object('Content-Type','application/json','X-Atlas-Scheduler-Time',t.signed_at,
    'X-Atlas-Scheduler',translate(rtrim(encode(extensions.hmac('POST'||chr(10)||'/internal/sampling-round'||chr(10)||t.signed_at,s.value->>'secret','sha256'),'base64'),'='),'+/','-_')),
  body:='{}'::jsonb,
  timeout_milliseconds:=10000
)
FROM brigade.app_secrets s,target t
WHERE s.key='sampling_scheduler' AND (
  NOT EXISTS (SELECT 1 FROM brigade.sample_round_events) OR
  (NOT t.is_break AND NOT EXISTS (
    SELECT 1 FROM brigade.sample_round_events e WHERE e.period_key=t.period_key AND e.completed_at IS NOT NULL
  ))
);
$job$);
