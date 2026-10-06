-- Bank-wise statements (S4): indexes only. No data change.
CREATE INDEX IF NOT EXISTS "BankTransaction_bankAccountId_date_idx" ON "BankTransaction"("bankAccountId", "date");
CREATE INDEX IF NOT EXISTS "BankTransaction_bankAccountId_idx" ON "BankTransaction"("bankAccountId");
