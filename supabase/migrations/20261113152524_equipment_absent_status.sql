-- Add equipment absence without changing any existing state, audit, grant or RLS policy.
-- One ALTER statement replaces the CHECK atomically; pad/well statuses retain their four values.
ALTER TABLE brigade.object_statuses
  DROP CONSTRAINT object_status_value,
  ADD CONSTRAINT object_status_value CHECK (
    status IN ('unknown','ok','attention','stopped')
    OR (status = 'absent' AND object_key LIKE 'equipment:%')
  );
