-- task2_: the Timesheet task lifecycle — start, complete, review.
--
-- HAND-WRITTEN ON PURPOSE. Plain `ALTER TABLE ... ADD COLUMN` only, and
-- nothing else. SQLite has no ALTER COLUMN, so Prisma implements any column
-- CHANGE as a CREATE/COPY/DROP/RENAME rebuild of the whole table, which
-- silently drops columns other migrations added. That has already caused a
-- real data-loss bug in this repo. Every statement below is additive and
-- every new column is nullable or carries a DEFAULT, so existing Task rows
-- stay exactly as they are.

-- When the assignee actually picked the work up, and when they marked it done.
-- `completedAt` is what finally makes an on-time-completion figure possible:
-- before this migration only the CURRENT status was known, never the moment.
ALTER TABLE "Task" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "completedAt" DATETIME;

-- The review leg. 'Not Submitted' until the assignee completes the task, then
-- 'Pending Review' until a reviewer decides: 'Approved' or 'Changes Requested'.
ALTER TABLE "Task" ADD COLUMN "reviewState" TEXT NOT NULL DEFAULT 'Not Submitted';
ALTER TABLE "Task" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "Task" ADD COLUMN "reviewedByName" TEXT;
ALTER TABLE "Task" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "reviewNote" TEXT;

-- A task that was already sitting at 'Completed' before the review leg existed
-- has never been through it, so it is left at the 'Not Submitted' default
-- rather than being back-dated into a review queue nobody submitted it to.
