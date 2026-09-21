-- Bank & Reconciliation depth.
--
-- Hand-written on purpose. Prisma implements any column change on SQLite as a
-- table rebuild (create new_X, copy a fixed column list, drop, rename), which
-- silently drops columns added by migrations it did not know about. Everything
-- here is a plain ADD COLUMN or a CREATE TABLE, so nothing existing is touched.

ALTER TABLE "BankTransaction" ADD COLUMN "bankAccountId" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BankTransaction" ADD COLUMN "category" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "categoryKind" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "vendor" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "counterparty" TEXT;
ALTER TABLE "BankTransaction" ADD COLUMN "excess" REAL;
ALTER TABLE "BankTransaction" ADD COLUMN "importFile" TEXT;

CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bank" TEXT NOT NULL,
    "name" TEXT,
    "accNo" TEXT,
    "ifsc" TEXT,
    "branch" TEXT,
    "openBal" REAL NOT NULL DEFAULT 0,
    "openDate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BankRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "match" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "vendor" TEXT,
    "gstRate" REAL,
    "kind" TEXT NOT NULL DEFAULT 'expense',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BankMark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT,
    "date" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'Bank balance on that date',
    "balance" REAL,
    "cleared" REAL,
    "match" TEXT,
    "note" TEXT,
    "recordedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT,
    "date" TEXT NOT NULL,
    "file" TEXT,
    "recordedBy" TEXT,
    "lines" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "credits" REAL NOT NULL DEFAULT 0,
    "debits" REAL NOT NULL DEFAULT 0,
    "fromDate" TEXT,
    "toDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
