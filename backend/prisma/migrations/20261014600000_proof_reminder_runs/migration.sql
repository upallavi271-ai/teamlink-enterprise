-- PROOF REMINDER RUNS (2026-10-14): the log + idempotency table of the daily WhatsApp / e-mail proof reminders
-- (utils/proofReminders.js). One row per (day, slot, accountant, channel); "runKey" is UNIQUE, so two processes or two
-- ticks can never send the same reminder twice. Records every attempt, the plain reason of a failure and the retries.
-- ADDITIVE ONLY: one new table, nothing existing is touched. Times are DATETIME columns holding epoch milliseconds (like every Prisma SQLite DateTime; an INTEGER column holding milliseconds cannot be read by raw queries). The application
-- reads / writes it with plain SQL and feature-detects it (until applied, the engine sends nothing and says so).
-- Undo: rollback.sql.
CREATE TABLE "ProofReminderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runKey" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "userId" TEXT,
    "userName" TEXT,
    "channel" TEXT NOT NULL,
    "toAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "recordKeys" TEXT,
    "leaseAt" DATETIME,
    "nextAttemptAt" DATETIME,
    "windowEndAt" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "ProofReminderRun_runKey_key" ON "ProofReminderRun"("runKey");
CREATE INDEX "ProofReminderRun_runDate_idx" ON "ProofReminderRun"("runDate", "slot");
CREATE INDEX "ProofReminderRun_status_idx" ON "ProofReminderRun"("status", "nextAttemptAt");
