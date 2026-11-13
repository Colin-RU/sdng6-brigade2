-- Review candidate only. The production migration gets its native assigned version after approval.
-- Additive private table; no existing rows, policies, grants or operational marks are changed.
CREATE TABLE brigade.native_push_tokens (
  id text PRIMARY KEY,
  installation_hash text NOT NULL,
  secret_hash text NOT NULL,
  user_id text NOT NULL REFERENCES brigade.profiles(id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES brigade.sessions(token_hash) ON DELETE CASCADE,
  token_hash text NOT NULL,
  token text NOT NULL,
  device_slot integer NOT NULL,
  app_version text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT native_push_slot CHECK (device_slot BETWEEN 1 AND 10),
  CONSTRAINT native_push_token_length CHECK (length(token) BETWEEN 20 AND 4096),
  CONSTRAINT native_push_version_length CHECK (app_version IS NULL OR length(app_version)<=32)
);
CREATE UNIQUE INDEX native_push_installation_unique ON brigade.native_push_tokens (installation_hash);
CREATE UNIQUE INDEX native_push_token_unique ON brigade.native_push_tokens (token_hash);
CREATE UNIQUE INDEX native_push_user_slot_unique ON brigade.native_push_tokens (user_id,device_slot);
CREATE INDEX native_push_session ON brigade.native_push_tokens (session_hash);
ALTER TABLE brigade.native_push_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brigade.native_push_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON brigade.native_push_tokens TO service_role;
