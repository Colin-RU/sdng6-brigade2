-- Nullable selection columns preserve legacy whole-pad marks and their audit without backfill.
ALTER TABLE brigade.samples ADD COLUMN well_ids text;
ALTER TABLE brigade.sample_audit ADD COLUMN well_ids text;
