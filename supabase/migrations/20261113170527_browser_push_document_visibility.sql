-- Additive bounded browser visibility lease. Existing subscriptions default to background delivery.
-- No notification/feed/counter/native-device data or permissions are modified.
ALTER TABLE brigade.push_subscriptions ADD COLUMN visible_until bigint NOT NULL DEFAULT 0;
CREATE TABLE brigade.push_visibility_leases (
  sub_id text NOT NULL REFERENCES brigade.push_subscriptions(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  sequence bigint NOT NULL,
  visible_until bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (sub_id,document_id)
);
ALTER TABLE brigade.push_visibility_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brigade.push_visibility_leases FROM PUBLIC, anon, authenticated;
GRANT ALL ON brigade.push_visibility_leases TO service_role;
