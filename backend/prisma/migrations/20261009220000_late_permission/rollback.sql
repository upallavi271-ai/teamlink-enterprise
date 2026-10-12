-- Undo 20261009220000_late_permission (drops the table and its rows).
DROP INDEX IF EXISTS "LatePermission_one_per_day";
DROP INDEX IF EXISTS "LatePermission_status_idx";
DROP INDEX IF EXISTS "LatePermission_employeeId_date_idx";
DROP TABLE IF EXISTS "LatePermission";
