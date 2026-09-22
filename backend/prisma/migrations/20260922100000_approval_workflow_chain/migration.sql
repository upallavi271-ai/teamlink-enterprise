-- approval_workflow_chain: hierarchy-based approval (§15/§16).
--
--   Employee → TL → STL → Manager → Asst Manager → Admin → Super Admin
--
-- HAND-WRITTEN, AND DELIBERATELY SO. SQLite has no ALTER COLUMN, so Prisma
-- implements any column change as a table REBUILD (create new, copy, drop,
-- rename) which silently drops columns added by other migrations — that has
-- caused a real bug in this repo. Everything below is CREATE TABLE / CREATE
-- INDEX on NEW tables. No existing table is touched at all: not rebuilt, not
-- even altered. LeaveRequest keeps exactly the columns it has, and every
-- existing leave query keeps working byte for byte.

-- --------------------------------------------------------------------------
-- 1. ApprovalStep — ONE ROW PER LEVEL PER RECORD.
--
-- `workflow` + `recordId` is what makes this shared rather than a leave
-- table: 'leave' today, and the employee-request / ATS / requirement /
-- Accounts approvals of §16 adopt the same two tables.
--
-- The resolved approver is STORED, not re-derived: the chain a request
-- climbed is a fact about that request, and re-resolving it later against
-- today's org chart would rewrite history whenever somebody changes teams.
-- --------------------------------------------------------------------------
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    -- required | visibility | applicant
    "mode" TEXT NOT NULL DEFAULT 'visibility',
    "slaHours" INTEGER,
    "approverUserId" TEXT,
    "approverName" TEXT,
    "approverDepartment" TEXT,
    -- Applied | Pending | Approved | Rejected | Waiting | Visibility | Skipped
    "status" TEXT NOT NULL DEFAULT 'Waiting',
    -- activatedAt + slaHours is ALL the ageing data there is. pending-since
    -- and overdue are computed when a screen is read; there is no scheduler
    -- in this app and no background job updates these rows.
    "activatedAt" DATETIME,
    "dueAt" DATETIME,
    "actedAt" DATETIME,
    "actedByUserId" TEXT,
    "actedByName" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ApprovalStep_workflow_recordId_idx" ON "ApprovalStep"("workflow", "recordId");
-- "Which requests am I on the chain of?" — the chain-membership half of
-- visibility, which every list endpoint asks once per request.
CREATE INDEX "ApprovalStep_workflow_approverUserId_idx" ON "ApprovalStep"("workflow", "approverUserId");

-- --------------------------------------------------------------------------
-- 2. ApprovalLevelConfig — REQUIRED vs VISIBILITY-ONLY, per level.
--
-- The chain is the MODEL; this is the POLICY. A seven-step mandatory chain
-- for a one-day casual leave would be absurd, so each level is configured as
-- either a required approver or a visibility-only watcher.
--
-- Rows are created LAZILY from the workflow's defaults the first time they
-- are read (utils/approvalWorkflow.js levelConfig), exactly as leave balances
-- are, so this migration seeds nothing and adopting a second workflow needs
-- no backfill migration either.
-- --------------------------------------------------------------------------
CREATE TABLE "ApprovalLevelConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflow" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'visibility',
    "slaHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ApprovalLevelConfig_workflow_level_key" ON "ApprovalLevelConfig"("workflow", "level");
