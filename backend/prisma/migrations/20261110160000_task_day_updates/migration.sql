-- Timesheet daily tracking (2026-11-10): how far a task has got, and one update per task per day. Additive only.
ALTER TABLE "Task" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "TaskDayUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "progress" INTEGER NOT NULL,
    "done" TEXT NOT NULL DEFAULT '',
    "why" TEXT NOT NULL DEFAULT '',
    "byId" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskDayUpdate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TaskDayUpdate_taskId_date_key" ON "TaskDayUpdate"("taskId", "date");
CREATE INDEX "TaskDayUpdate_date_idx" ON "TaskDayUpdate"("date");
