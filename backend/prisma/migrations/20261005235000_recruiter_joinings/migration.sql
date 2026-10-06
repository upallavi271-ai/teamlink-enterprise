-- 20261005235000_recruiter_joinings  (HRMS -> Recruiter joinings, 2026-10-05)
-- ADDITIVE ONLY: 2 new tables + 1 defaulted column on "EmployeePayrollRun"
-- and 1 on "Payslip". No existing column is changed, no row is touched.
--
-- RecruiterJoiningTarget   the joinings target per month (default 4, set by
--                          Super Admin for everyone / a department / one
--                          person, from a month onward)
-- RecruiterJoiningDecision Super Admin's decision per recruiter per month:
--                          INCENTIVE (amount, paid in payMonth's payroll) |
--                          RAISE (the SalaryStructureVersion it created) | NONE
-- EmployeePayrollRun.incentive / Payslip.incentive  the "Incentive" earning line

CREATE TABLE "RecruiterJoiningTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "fromMonth" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "note" TEXT,
    "setById" TEXT,
    "setByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RecruiterJoiningTarget_scope_scopeKey_fromMonth_key" ON "RecruiterJoiningTarget"("scope", "scopeKey", "fromMonth");

CREATE TABLE "RecruiterJoiningDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "joinings" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL,
    "amount" REAL,
    "payMonth" TEXT,
    "payrollEntryId" TEXT,
    "salaryVersionId" TEXT,
    "raiseFrom" TEXT,
    "note" TEXT,
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RecruiterJoiningDecision_employeeId_month_key" ON "RecruiterJoiningDecision"("employeeId", "month");
CREATE INDEX "RecruiterJoiningDecision_month_idx" ON "RecruiterJoiningDecision"("month");
CREATE INDEX "RecruiterJoiningDecision_payMonth_decision_idx" ON "RecruiterJoiningDecision"("payMonth", "decision");

ALTER TABLE "EmployeePayrollRun" ADD COLUMN "incentive" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Payslip" ADD COLUMN "incentive" REAL DEFAULT 0;
