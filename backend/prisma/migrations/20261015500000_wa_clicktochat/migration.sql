-- WHATSAPP CLICK-TO-CHAT (2026-10-15): free wa.me quick chat for HRMS / ATS / Accounts. NO API, NO sending from the server:
-- the person's own browser opens wa.me; these tables only hold the wording (templates), an append-only log of "Opened",
-- the opt-in flag, and per-user bulk "queue" sessions so a half-done list survives a closed window or another device.
-- ADDITIVE ONLY: four new tables, nothing existing is touched. Times are DATETIME columns holding epoch milliseconds.
-- The application reads / writes them with plain SQL and feature-detects them (until applied it says "being set up").
-- Undo: rollback.sql.
CREATE TABLE "WaTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL DEFAULT 'General',
    "body" TEXT NOT NULL,
    "systemKey" TEXT,
    "isSystem" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "WaTemplate_systemKey_key" ON "WaTemplate"("systemKey");

CREATE TABLE "WaLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "userName" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "recipientName" TEXT,
    "number" TEXT,
    "module" TEXT,
    "templateId" TEXT,
    "templateName" TEXT,
    "source" TEXT NOT NULL DEFAULT 'single',
    "batchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Opened',
    "messageLength" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "WaLog_createdAt_idx" ON "WaLog"("createdAt");
CREATE INDEX "WaLog_userId_idx" ON "WaLog"("userId", "createdAt");

CREATE TABLE "WaOptIn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "optedIn" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "setById" TEXT,
    "setByName" TEXT,
    "setAt" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "WaOptIn_entity_key" ON "WaOptIn"("entityType", "entityId");

CREATE TABLE "WaBulkSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "entityType" TEXT NOT NULL,
    "module" TEXT,
    "templateId" TEXT,
    "templateName" TEXT,
    "templateBody" TEXT,
    "requirementId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "items" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT 0
);
CREATE INDEX "WaBulkSession_user_idx" ON "WaBulkSession"("userId", "status");
