-- Reviewed candidate, production filename is assigned by native apply_migration.
-- No previous field marks or audit rows are rewritten.
ALTER TABLE brigade.samples ADD COLUMN round_key text;
ALTER TABLE brigade.sample_audit ADD COLUMN round_key text;
ALTER TABLE brigade.notifications ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE brigade.notifications ALTER COLUMN note_id DROP NOT NULL;
ALTER TABLE brigade.notifications ALTER COLUMN parent_id DROP NOT NULL;
ALTER TABLE brigade.notifications ADD COLUMN round_key text;
CREATE INDEX notifications_round_seq ON brigade.notifications (round_key,seq);
CREATE TABLE brigade.sample_round_events (
  period_key text PRIMARY KEY,
  starts_at bigint NOT NULL,
  ends_at bigint NOT NULL,
  created_at bigint NOT NULL,
  mutation_id text NOT NULL,
  lease_token text,
  lease_until bigint NOT NULL DEFAULT 0,
  dispatch_cursor bigint NOT NULL DEFAULT 0,
  completed_at bigint,
  retry_ids text NOT NULL DEFAULT '[]'
);
ALTER TABLE brigade.sample_round_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brigade.sample_round_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON brigade.sample_round_events TO service_role;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
