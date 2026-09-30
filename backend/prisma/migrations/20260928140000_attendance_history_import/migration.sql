-- Past attendance imported from the old HRMS (PulseHRM CSV exports). Additive only.
-- Values are kept exactly as exported; the employee is matched by Employee ID
-- against Employee Management (never by name / department from the file).

CREATE TABLE "AttendanceHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeRef" TEXT NOT NULL,
    "employeeId" TEXT,
    "matchStatus" TEXT NOT NULL,
    "sourceName" TEXT,
    "date" TEXT NOT NULL,
    "firstCheckIn" TEXT,
    "lastCheckOut" TEXT,
    "totalTimeWorked" TEXT,
    "totalBreak" TEXT,
    "totalHours" TEXT,
    "workLocation" TEXT,
    "punchTimes" TEXT,
    "sources" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "importBatch" TEXT NOT NULL,
    "importedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AttendanceHistory_employeeRef_date_key" ON "AttendanceHistory"("employeeRef", "date");
CREATE INDEX "AttendanceHistory_employeeId_date_idx" ON "AttendanceHistory"("employeeId", "date");

CREATE TABLE "AttendanceHistorySummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeRef" TEXT NOT NULL,
    "employeeId" TEXT,
    "matchStatus" TEXT NOT NULL,
    "sourceName" TEXT,
    "periodFrom" TEXT NOT NULL,
    "periodTo" TEXT NOT NULL,
    "location" TEXT,
    "halfDay" REAL,
    "present" REAL,
    "weekOffs" REAL,
    "publicHolidays" REAL,
    "leaves" REAL,
    "payableDays" REAL,
    "totalHours" TEXT,
    "importBatch" TEXT NOT NULL,
    "importedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AttendanceHistorySummary_employeeRef_periodFrom_periodTo_key" ON "AttendanceHistorySummary"("employeeRef", "periodFrom", "periodTo");
