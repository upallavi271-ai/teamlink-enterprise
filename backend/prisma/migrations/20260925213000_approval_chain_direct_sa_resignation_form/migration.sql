-- Approval chain (spec item 2) + full resignation form (spec item 7).
-- Hand-written and additive: one new column on ApprovalStep, two nullable
-- columns on HrConfig, one new table. `prisma migrate diff` is not used
-- because of older, unrelated drift.

-- "Direct Super Admin Approval" flag on the step carrying an SA override.
ALTER TABLE "ApprovalStep" ADD COLUMN "direct" BOOLEAN NOT NULL DEFAULT false;

-- Resignation form configuration.
ALTER TABLE "HrConfig" ADD COLUMN "resignationReasons" TEXT;
ALTER TABLE "HrConfig" ADD COLUMN "resignationOptionalFields" TEXT;

-- The resignation form, one row per RESIGNATION EmployeeRecord.
CREATE TABLE "ResignationDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "employeeName" TEXT,
    "department" TEXT,
    "designation" TEXT,
    "reportingManager" TEXT,
    "resignationDate" TEXT NOT NULL,
    "requestedLastWorkingDate" TEXT,
    "approvedLastWorkingDate" TEXT,
    "reason" TEXT NOT NULL,
    "reasonOther" TEXT,
    "comments" TEXT,
    "noticePeriodDays" INTEGER,
    "handoverDetails" TEXT,
    "knowledgeTransferDetails" TEXT,
    "exitComments" TEXT,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedByUserId" TEXT,
    "submittedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ResignationDetail_recordId_key" ON "ResignationDetail"("recordId");
CREATE INDEX "ResignationDetail_employeeId_idx" ON "ResignationDetail"("employeeId");

-- The level CONFIG rows follow the new ladder order (Employee -> TL -> STL ->
-- HR -> Assistant Manager -> Manager -> Super Admin). Display order only:
-- live requests keep the seq stored on their own ApprovalStep rows.
UPDATE "ApprovalLevelConfig" SET "seq" = 4 WHERE "level" = 'HR';
UPDATE "ApprovalLevelConfig" SET "seq" = 5 WHERE "level" = 'ASSISTANT_MANAGER';
UPDATE "ApprovalLevelConfig" SET "seq" = 6 WHERE "level" = 'MANAGER';
