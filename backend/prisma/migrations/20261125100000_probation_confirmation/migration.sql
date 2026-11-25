-- CreateTable
CREATE TABLE "ProbationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "team" TEXT,
    "designation" TEXT,
    "startDate" DATETIME NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 3,
    "endDate" DATETIME NOT NULL,
    "originalEndDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'In probation',
    "reviewerUserId" TEXT,
    "reviewerName" TEXT,
    "reviewScore" INTEGER,
    "reviewRecommendation" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" DATETIME,
    "reviewedByName" TEXT,
    "confirmedOn" DATETIME,
    "decisionNote" TEXT,
    "decidedByName" TEXT,
    "decidedAt" DATETIME,
    "letterDocumentId" TEXT,
    "remindState" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProbationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" TEXT,
    "byName" TEXT,
    "fromEnd" DATETIME,
    "toEnd" DATETIME,
    "score" INTEGER,
    "recommendation" TEXT,
    "note" TEXT,
    CONSTRAINT "ProbationEvent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "ProbationRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProbationRecord_employeeId_key" ON "ProbationRecord"("employeeId");

-- CreateIndex
CREATE INDEX "ProbationRecord_status_endDate_idx" ON "ProbationRecord"("status", "endDate");

-- CreateIndex
CREATE INDEX "ProbationRecord_department_idx" ON "ProbationRecord"("department");

-- CreateIndex
CREATE INDEX "ProbationEvent_recordId_at_idx" ON "ProbationEvent"("recordId", "at");

