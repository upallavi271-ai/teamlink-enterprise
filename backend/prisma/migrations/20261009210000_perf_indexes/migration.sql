-- BATCH 1 (ATS 360 review, 2026-10-09) - performance indexes. ADDITIVE ONLY.
-- Every statement is IF NOT EXISTS, so it is safe to re-run. Undo: rollback.sql.
-- Each index below is justified by a query the app really runs (see the
-- comment above it). Names follow Prisma's  <Model>_<cols>_idx  convention so
-- the @@index lines added to schema.prisma match them exactly (no drift).
--
-- NOT added on purpose (checked against the code, 2026-10-09):
--   Candidate(email) / (phone) / (name): every lookup in the app is
--     `contains` (LIKE '%x%'), which a b-tree index cannot serve; the
--     duplicate check and the list work on the in-memory copy. An index would
--     only slow the 17k-row imports down.
--   User(role): the table has ~45 rows; a scan is as fast as an index.
--   Application(requirementId) / (stage) / (candidateId): already indexed
--     (Application_requirementId_idx, Application_stage_idx, and the unique
--     (candidateId, requirementId) whose first column serves candidateId).

-- Candidate 360 audit tab, the audit screens and every "last X for this
-- record" lookup: WHERE entity = ? AND entityId (= ? / IN (...)) ORDER BY
-- createdAt DESC LIMIT n   (routes/candidates.js, clients.js, agreementSeal.js,
-- jobLifecycleRoutes.js ...). AuditLog had no index at all.
CREATE INDEX IF NOT EXISTS "AuditLog_entity_entityId_createdAt_idx" ON "AuditLog"("entity", "entityId", "createdAt");
-- "Latest activity" panels: ORDER BY createdAt DESC LIMIT n with no entity filter.
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- The bell and the dashboard: WHERE userId = me AND read = false AND createdAt >= ...
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- Leave screens and the HRMS dashboard: WHERE employeeId (= / IN) AND status ... / date overlap.
CREATE INDEX IF NOT EXISTS "LeaveRequest_employeeId_status_idx" ON "LeaveRequest"("employeeId", "status");

-- Integration health + dashboard "failed syncs": WHERE status = 'Failed' AND createdAt >= ... ORDER BY createdAt DESC.
CREATE INDEX IF NOT EXISTS "SyncLog_status_createdAt_idx" ON "SyncLog"("status", "createdAt");

-- Per-job stage counts and "people at stage X on job Y": WHERE requirementId = ? AND stage (= / IN).
CREATE INDEX IF NOT EXISTS "Application_requirementId_stage_idx" ON "Application"("requirementId", "stage");

-- Reports (funnel, time-to-fill, rejections, sla) and the client-shared check:
-- WHERE toStage (= / IN) AND createdAt BETWEEN ...
CREATE INDEX IF NOT EXISTS "ApplicationStageEvent_toStage_createdAt_idx" ON "ApplicationStageEvent"("toStage", "createdAt");
