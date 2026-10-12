-- Undo 20261009210000_perf_indexes (drops only the indexes this migration created).
DROP INDEX IF EXISTS "AuditLog_entity_entityId_createdAt_idx";
DROP INDEX IF EXISTS "AuditLog_createdAt_idx";
DROP INDEX IF EXISTS "Notification_userId_createdAt_idx";
DROP INDEX IF EXISTS "LeaveRequest_employeeId_status_idx";
DROP INDEX IF EXISTS "SyncLog_status_createdAt_idx";
DROP INDEX IF EXISTS "Application_requirementId_stage_idx";
DROP INDEX IF EXISTS "ApplicationStageEvent_toStage_createdAt_idx";
