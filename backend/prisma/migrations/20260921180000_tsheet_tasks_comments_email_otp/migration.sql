-- tsheet_: Timesheet tasks, task comments and Add Employee's email OTP.
--
-- HAND-WRITTEN ON PURPOSE. This migration only CREATEs new tables and indexes.
-- There is no ALTER TABLE and no table rebuild: SQLite has no ALTER COLUMN, so
-- Prisma implements any column change as a CREATE/COPY/DROP/RENAME rebuild,
-- which silently drops columns other migrations added. That has already caused
-- a real data-loss bug in this repo, so nothing here touches an existing table.

-- A task on the Timesheet screen. assigneeId / assignedById hold a User.id as
-- plain columns (no FOREIGN KEY to User), so the User table is never rebuilt.
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "description" TEXT,
    "subTaskName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Not Started',
    "startDate" TEXT,
    "endDate" TEXT,
    "dependent" BOOLEAN NOT NULL DEFAULT false,
    "dependsOnId" TEXT,
    "assigneeId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assigneeName" TEXT NOT NULL,
    "assignedByName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Task_assigneeId_idx" ON "Task"("assigneeId");
CREATE INDEX "Task_assignedById_idx" ON "Task"("assignedById");
CREATE INDEX "Task_department_idx" ON "Task"("department");

-- The comment thread behind the task row's comment button.
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskComment_taskId_idx" ON "TaskComment"("taskId");

-- Add Employee's "Send OTP". Only the SHA-256 hash of the code is stored, with
-- a short expiry and an attempt counter that caps guessing.
CREATE TABLE "EmailVerification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'employee-signup',
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" DATETIME,
    "consumedAt" DATETIME,
    "requestedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "EmailVerification_email_idx" ON "EmailVerification"("email");
