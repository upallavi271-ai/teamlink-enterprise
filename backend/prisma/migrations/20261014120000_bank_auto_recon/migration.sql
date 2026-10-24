-- Automatic bank statement matching & reconciliation (Accounts > Bank & Reconciliation > Auto-Reconcile).
-- ADDITIVE ONLY: three new tables, two new nullable columns on BankImport, indexes.
-- No existing row is rewritten, no existing column dropped or retyped.
-- Undo: rollback.sql in this folder.

-- One historical / on-demand reconciliation run (dry run or real), processed in batches and resumable.
CREATE TABLE "ReconRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "bankAccountId" TEXT,
    "fromDate" TEXT,
    "toDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Queued', -- Queued | Running | Paused | Done | Failed | Cancelled
    "autoApply" BOOLEAN NOT NULL DEFAULT false, -- the Auto-reconcile switch as it was when the run started
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT, -- "<date>|<id>" of the last line fully processed
    "counts" TEXT, -- JSON: autoMatched, suggested, unmatched, duplicates, mismatches, needsReview, flaggedExisting, debit, credit ...
    "preview" TEXT, -- JSON: what the screen showed before the run started
    "error" TEXT,
    "startedById" TEXT,
    "startedByName" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReconRun_status_idx" ON "ReconRun"("status");

-- What the engine thinks about ONE bank line (or about an existing match that looks wrong).
-- A dry run writes ONLY this table. idemKey = txn + target + parts, so re-running never duplicates.
CREATE TABLE "ReconProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idemKey" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "runId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import', -- import | historical | rescan | existing-check
    "kind" TEXT NOT NULL, -- invoice | receipt-proof | expense | reversal | transfer | charge | salary-hint | flag | none
    "band" TEXT NOT NULL, -- high | medium | low
    "rule" INTEGER,
    "action" TEXT, -- JSON the apply step runs through the existing helpers
    "targetType" TEXT,
    "targetIds" TEXT, -- JSON array
    "targetLabel" TEXT, -- invoice / bill number(s) for the table
    "party" TEXT,
    "bookAmount" REAL,
    "allocated" REAL,
    "difference" REAL,
    "reasons" TEXT, -- JSON array: why it was suggested / auto-confirmed
    "flags" TEXT, -- JSON array: duplicate, amount-mismatch, bill-not-approved, closed-period ...
    "candidates" TEXT, -- JSON: other plausible records
    "status" TEXT NOT NULL DEFAULT 'Pending', -- Pending | Applied | Rejected | Superseded | Stale | Reversed
    "appliedMode" TEXT, -- auto | approved
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "previous" TEXT, -- JSON snapshot taken before the apply (for the audit trail)
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReconProposal_idemKey_key" ON "ReconProposal"("idemKey");
CREATE INDEX "ReconProposal_txnId_status_idx" ON "ReconProposal"("txnId", "status");
CREATE INDEX "ReconProposal_status_band_idx" ON "ReconProposal"("status", "band");
CREATE INDEX "ReconProposal_runId_idx" ON "ReconProposal"("runId");

-- Append-only event stream: every automatic decision and every person's action. Never updated or deleted.
CREATE TABLE "ReconEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "txnId" TEXT,
    "proposalId" TEXT,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "actorId" TEXT,
    "actorName" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "reason" TEXT
);
CREATE INDEX "ReconEvent_txnId_at_idx" ON "ReconEvent"("txnId", "at");
CREATE INDEX "ReconEvent_runId_idx" ON "ReconEvent"("runId");

-- Original uploaded statement kept for audit (stored name from utils/attachments.js).
ALTER TABLE "BankImport" ADD COLUMN "originalFile" TEXT;
ALTER TABLE "BankImport" ADD COLUMN "originalName" TEXT;
