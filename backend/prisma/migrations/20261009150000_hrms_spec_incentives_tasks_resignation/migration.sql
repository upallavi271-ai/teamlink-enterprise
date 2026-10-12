-- HRMS spec 2026-10-09 (points 4, 7, 8).
-- ADDITIVE ONLY: two new tables + new columns that are nullable or carry a
-- default. No existing column is changed, no row is rewritten.
-- Undo: rollback.sql in this folder.

-- Point 7 (Timesheet): task priority (High / Medium / Low) and the day the
-- last "your task is overdue" reminder went out (at most one a day per task).
ALTER TABLE "Task" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'Medium';
ALTER TABLE "Task" ADD COLUMN "overdueRemindedOn" TEXT;
CREATE INDEX "Task_priority_idx" ON "Task"("priority");
CREATE INDEX "Task_endDate_idx" ON "Task"("endDate");

-- Point 8 (Resignation): the time of day the resignation was given, where it
-- came from, and the import batch it arrived in.
ALTER TABLE "ResignationDetail" ADD COLUMN "resignationTime" TEXT; -- HH:MM, 24-hour
ALTER TABLE "ResignationDetail" ADD COLUMN "source" TEXT;          -- Filed in TeamLink | Imported (file name)
ALTER TABLE "ResignationDetail" ADD COLUMN "importBatch" TEXT;

-- Point 4 (Incentives): the department-wise rule table (Super Admin edits it;
-- it starts EMPTY) and one award per person per month per rule.
CREATE TABLE "IncentiveRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "department" TEXT,                              -- NULL = every department
    "role" TEXT,                                    -- designation / role it applies to; NULL = everyone in the department
    "metric" TEXT NOT NULL DEFAULT 'JOININGS',      -- JOININGS (from ATS) | TARGET (Monthly Target achieved) | MANUAL (HR types the number)
    "minAchieved" REAL NOT NULL DEFAULT 0,          -- eligibility: at least this much achieved in the month
    "target" REAL,                                  -- the target this rule measures against (optional)
    "basis" TEXT NOT NULL DEFAULT 'FIXED',          -- FIXED | PER_UNIT | PER_UNIT_OVER_TARGET
    "amount" REAL NOT NULL DEFAULT 0,               -- rupees
    "maxAmount" REAL,                               -- optional cap per person per month
    "fromMonth" TEXT NOT NULL DEFAULT '',           -- YYYY-MM it starts; '' = from the beginning
    "toMonth" TEXT,                                 -- YYYY-MM it stops (inclusive); NULL = open
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "IncentiveRule_department_idx" ON "IncentiveRule"("department");
CREATE INDEX "IncentiveRule_active_idx" ON "IncentiveRule"("active");

CREATE TABLE "IncentiveAward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupeKey" TEXT NOT NULL,                      -- employeeId|month|ruleId (or MANUAL|…): one award per person per month per rule
    "employeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,                          -- YYYY-MM the work was done in
    "ruleId" TEXT,
    "ruleName" TEXT,
    "department" TEXT,
    "metric" TEXT NOT NULL DEFAULT 'MANUAL',
    "achieved" REAL NOT NULL DEFAULT 0,
    "target" REAL,
    "amount" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Pending',       -- Pending | Approved | Rejected | Paid
    "source" TEXT NOT NULL DEFAULT 'RULE',          -- RULE | MANUAL
    "payMonth" TEXT,                                -- Approved: the payroll month it is paid in
    "payrollEntryId" TEXT,                          -- the EmployeePayrollRun that carries it
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "IncentiveAward_dedupeKey_key" ON "IncentiveAward"("dedupeKey");
CREATE INDEX "IncentiveAward_employeeId_month_idx" ON "IncentiveAward"("employeeId", "month");
CREATE INDEX "IncentiveAward_status_payMonth_idx" ON "IncentiveAward"("status", "payMonth");
