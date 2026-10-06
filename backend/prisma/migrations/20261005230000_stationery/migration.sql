-- 20261005230000_stationery  (Employee Services -> Stationery, 2026-10-05)
-- ADDITIVE ONLY: 3 new tables. No existing table or row is touched.
-- Seeds the two starter items the user named (Notepad, Pen) — item names
-- only, no stock (HR adds the real stock themselves).

CREATE TABLE "StationeryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "reorderLevel" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "StationeryItem_name_key" ON "StationeryItem"("name");

CREATE TABLE "StationeryStock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "vendor" TEXT,
    "costPerUnit" REAL,
    "billNo" TEXT,
    "note" TEXT,
    "addedById" TEXT,
    "addedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StationeryStock_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StationeryItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "StationeryStock_itemId_idx" ON "StationeryStock"("itemId");
CREATE INDEX "StationeryStock_date_idx" ON "StationeryStock"("date");

CREATE TABLE "StationeryIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ISSUE',
    "date" TEXT NOT NULL,
    "note" TEXT,
    "batchId" TEXT,
    "issuedById" TEXT,
    "issuedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StationeryIssue_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StationeryItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "StationeryIssue_employeeId_idx" ON "StationeryIssue"("employeeId");
CREATE INDEX "StationeryIssue_itemId_idx" ON "StationeryIssue"("itemId");
CREATE INDEX "StationeryIssue_date_idx" ON "StationeryIssue"("date");
CREATE INDEX "StationeryIssue_batchId_idx" ON "StationeryIssue"("batchId");

-- Starter items (names only, no stock). Timestamps as epoch ms, the way
-- Prisma itself stores DateTime in SQLite (same form as earlier seeds).
INSERT INTO "StationeryItem" ("id", "name", "unit", "active", "createdAt", "updatedAt")
VALUES ('stationery_item_notepad', 'Notepad', 'pcs', true, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
       ('stationery_item_pen', 'Pen', 'pcs', true, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
