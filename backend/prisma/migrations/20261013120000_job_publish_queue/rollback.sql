-- Undo 20261013120000_job_publish_queue. Drops the five engine tables (and with them every queue row, log,
-- stored portal credential and mapping). RequirementPosting and everything else are untouched.
-- Take a backup first if the queue holds anything you need.
DROP TABLE IF EXISTS "PostingLog";
DROP TABLE IF EXISTS "PostingQueue";
DROP TABLE IF EXISTS "PortalPosting";
DROP TABLE IF EXISTS "PortalMapping";
DROP TABLE IF EXISTS "PortalCredential";
