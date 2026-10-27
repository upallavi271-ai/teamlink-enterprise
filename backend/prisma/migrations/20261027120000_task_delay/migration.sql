-- TaskDelay: why a timesheet task is late + the new day asked for, and the decision (founder 2026-10-27)
CREATE TABLE "TaskDelay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "oldDate" TEXT,
    "newDate" TEXT NOT NULL,
    "askedById" TEXT NOT NULL,
    "askedByName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" DATETIME,
    "decideNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskDelay_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskDelay_taskId_idx" ON "TaskDelay"("taskId");
CREATE INDEX "TaskDelay_status_idx" ON "TaskDelay"("status");
