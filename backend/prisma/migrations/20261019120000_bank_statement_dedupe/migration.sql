-- Bank statement duplicate detection + selective import (2026-10-19). ADDITIVE ONLY: three new tables, one trigger.
-- No column is added to, and no row is changed in, any existing table. The app also creates these itself with IF NOT EXISTS
-- the first time a statement is previewed or imported (src/utils/bankStatementDedupe.js).
--   BankStmtBatch  one row per uploaded statement file: file name, who, when, the account, the result (Preview | Done | Partial | Failed)
--   BankStmtRow    one row per uploaded transaction: its status (Already Imported | Not Imported | Duplicate in Current Upload | Needs Review),
--                  the person's choice, the result (Imported | Failed + reason | Skipped) and the bank line it became
--   BankTxnKey     the atomic duplicate guard: every saved bank line owns key rows; the UNIQUE index (bankAccountId, key, ordinal) makes a
--                  second copy impossible even for two uploads at the same moment. Old lines get their keys written the first time an
--                  import runs; a twin among them takes ordinal 2. Deleting a bank line removes its keys (trigger), so it can be imported again.
CREATE TABLE IF NOT EXISTS "BankStmtBatch" ( "id" TEXT NOT NULL PRIMARY KEY, "bankAccountId" TEXT, "file" TEXT, "sourceHash" TEXT, "sheet" TEXT, "source" TEXT, "uploadedById" TEXT, "uploadedByName" TEXT, "status" TEXT NOT NULL DEFAULT 'Preview', "importId" TEXT, "eligible" INTEGER NOT NULL DEFAULT 0, "statedJson" TEXT, "balanceCheckJson" TEXT, "runs" INTEGER NOT NULL DEFAULT 0, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL, "lastRunAt" TEXT, "lastRunById" TEXT, "lastRunByName" TEXT );
CREATE INDEX IF NOT EXISTS "BankStmtBatch_account" ON "BankStmtBatch"("bankAccountId", "createdAt");
CREATE INDEX IF NOT EXISTS "BankStmtBatch_hash" ON "BankStmtBatch"("sourceHash");
CREATE TABLE IF NOT EXISTS "BankStmtRow" ( "id" TEXT NOT NULL PRIMARY KEY, "batchId" TEXT NOT NULL, "rowNo" INTEGER NOT NULL, "line" INTEGER, "status" TEXT NOT NULL, "reason" TEXT, "matchTxnId" TEXT, "decision" TEXT, "result" TEXT, "error" TEXT, "txnId" TEXT, "dedupeKey" TEXT, "txnRef" TEXT, "date" TEXT, "type" TEXT, "paise" INTEGER, "narration" TEXT, "rowJson" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0, "importedAt" TEXT, "updatedAt" TEXT );
CREATE UNIQUE INDEX IF NOT EXISTS "BankStmtRow_batch_row" ON "BankStmtRow"("batchId", "rowNo");
CREATE INDEX IF NOT EXISTS "BankStmtRow_batch_status" ON "BankStmtRow"("batchId", "status");
CREATE INDEX IF NOT EXISTS "BankStmtRow_txn" ON "BankStmtRow"("txnId");
CREATE TABLE IF NOT EXISTS "BankTxnKey" ( "id" INTEGER PRIMARY KEY AUTOINCREMENT, "txnId" TEXT NOT NULL, "bankAccountId" TEXT NOT NULL, "kind" TEXT NOT NULL, "key" TEXT NOT NULL, "ordinal" INTEGER NOT NULL DEFAULT 1, "batchId" TEXT, "note" TEXT, "createdAt" TEXT NOT NULL );
CREATE UNIQUE INDEX IF NOT EXISTS "BankTxnKey_unique" ON "BankTxnKey"("bankAccountId", "key", "ordinal");
CREATE UNIQUE INDEX IF NOT EXISTS "BankTxnKey_txn_key" ON "BankTxnKey"("txnId", "key");
CREATE INDEX IF NOT EXISTS "BankTxnKey_txn" ON "BankTxnKey"("txnId");
CREATE TRIGGER IF NOT EXISTS "BankTxnKey_cleanup" AFTER DELETE ON "BankTransaction"
BEGIN
  DELETE FROM "BankTxnKey" WHERE "txnId" = OLD."id";
END;
