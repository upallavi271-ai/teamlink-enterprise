-- Rollback of 20261019120000_bank_statement_dedupe. Deletes the upload batches, their rows and the duplicate-guard keys; no bank line,
-- import history row or any other table is touched. (After this, statements import exactly as before the feature.)
DROP TRIGGER IF EXISTS "BankTxnKey_cleanup";
DROP TABLE IF EXISTS "BankTxnKey";
DROP TABLE IF EXISTS "BankStmtRow";
DROP TABLE IF EXISTS "BankStmtBatch";
