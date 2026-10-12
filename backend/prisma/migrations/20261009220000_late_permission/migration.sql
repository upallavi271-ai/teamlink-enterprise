-- Late permission request (user, 2026-10-09): an employee applies in the app to come in late on a date
-- (expected arrival time + reason); approvers decide like a leave. ADDITIVE ONLY: one new table.
-- Undo: rollback.sql. Settings (allowance per month, how many past days may be applied for) live in AppSetting
-- (keys latePermission.monthlyAllowance / latePermission.pastDays), so there is no HrConfig column.
CREATE TABLE "LatePermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "expectedTime" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedBy" TEXT,
    "decidedById" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "cancelledAt" DATETIME,
    CONSTRAINT "LatePermission_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "LatePermission_employeeId_date_idx" ON "LatePermission"("employeeId", "date");
CREATE INDEX "LatePermission_status_idx" ON "LatePermission"("status");
-- One request per person per date, among the ones that are not cancelled (a cancelled one may be applied for again).
CREATE UNIQUE INDEX "LatePermission_one_per_day" ON "LatePermission"("employeeId", "date") WHERE "status" <> 'Cancelled';
