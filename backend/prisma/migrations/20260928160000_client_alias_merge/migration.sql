-- Duplicate-client merge support. Additive only.
-- ClientAlias: every name a merged-away client had, so imports and search find
-- the surviving client instead of re-creating the old spelling.
CREATE TABLE "ClientAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'merge',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ClientAlias_aliasKey_key" ON "ClientAlias"("aliasKey");
CREATE INDEX "ClientAlias_clientId_idx" ON "ClientAlias"("clientId");

-- ClientMerge: one row per merge, with a full snapshot of every merged-away
-- client row and what was moved, for traceability.
CREATE TABLE "ClientMerge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "primaryId" TEXT NOT NULL,
    "primaryName" TEXT NOT NULL,
    "donorIds" TEXT NOT NULL,
    "donorSnapshot" TEXT NOT NULL,
    "moved" TEXT NOT NULL,
    "filledFields" TEXT,
    "note" TEXT,
    "mergedById" TEXT,
    "mergedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ClientMerge_primaryId_idx" ON "ClientMerge"("primaryId");
