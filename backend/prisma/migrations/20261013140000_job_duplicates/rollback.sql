-- Rolls back 20261013140000_job_duplicates (the three tables only; no job row was changed by the migration).
DROP TABLE IF EXISTS "JobAlias";
DROP TABLE IF EXISTS "JobMergeLog";
DROP TABLE IF EXISTS "JobDupDecision";
