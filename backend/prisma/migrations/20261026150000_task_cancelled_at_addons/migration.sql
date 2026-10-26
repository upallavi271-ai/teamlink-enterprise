-- Task: when / by whom it was cancelled; TaskAddOn: extra work added onto a task (founder 2026-10-26)
ALTER TABLE "Task" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "cancelledByName" TEXT;

-- tasks cancelled before this: the day comes from their "Task cancelled" audit row
UPDATE "Task" SET
  "cancelledAt" = (SELECT MAX(a."createdAt") FROM "AuditLog" a WHERE a."entityId" = "Task"."id" AND a."action" = 'Task cancelled'),
  "cancelledByName" = (SELECT u."name" FROM "AuditLog" a JOIN "User" u ON u."id" = a."userId" WHERE a."entityId" = "Task"."id" AND a."action" = 'Task cancelled' ORDER BY a."createdAt" DESC LIMIT 1)
WHERE "status" = 'Cancelled';

CREATE TABLE "TaskAddOn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dueDate" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" DATETIME,
    "doneByName" TEXT,
    "addedById" TEXT NOT NULL,
    "addedByName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAddOn_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskAddOn_taskId_idx" ON "TaskAddOn"("taskId");
