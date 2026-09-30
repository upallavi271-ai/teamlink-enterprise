-- ATS dashboard performance: indexes on the hot filters. ADDITIVE only.
CREATE INDEX IF NOT EXISTS "Application_requirementId_idx" ON "Application"("requirementId");
CREATE INDEX IF NOT EXISTS "Application_stage_idx" ON "Application"("stage");
CREATE INDEX IF NOT EXISTS "Application_createdAt_idx" ON "Application"("createdAt");
CREATE INDEX IF NOT EXISTS "Application_interviewAt_idx" ON "Application"("interviewAt");
CREATE INDEX IF NOT EXISTS "ApplicationStageEvent_createdAt_idx" ON "ApplicationStageEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "ApplicationStageEvent_actorPositionCode_idx" ON "ApplicationStageEvent"("actorPositionCode");
CREATE INDEX IF NOT EXISTS "ApplicationFollowUp_ownerPositionCode_idx" ON "ApplicationFollowUp"("ownerPositionCode");
CREATE INDEX IF NOT EXISTS "Requirement_clientId_idx" ON "Requirement"("clientId");
CREATE INDEX IF NOT EXISTS "Requirement_recruiterId_idx" ON "Requirement"("recruiterId");
CREATE INDEX IF NOT EXISTS "Requirement_tlId_idx" ON "Requirement"("tlId");
CREATE INDEX IF NOT EXISTS "Requirement_department_idx" ON "Requirement"("department");
CREATE INDEX IF NOT EXISTS "Candidate_createdAt_idx" ON "Candidate"("createdAt");
