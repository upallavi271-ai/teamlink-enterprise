-- Omni-Channel v2: credits ledger + per-person monthly allowance (raw SQL tables, no Prisma model; the app also creates them itself with IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "OmniCreditLedger" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT, "userName" TEXT, "department" TEXT, "at" INTEGER NOT NULL, "channel" TEXT NOT NULL, "credits" INTEGER NOT NULL DEFAULT 0, "mode" TEXT NOT NULL DEFAULT 'live', "campaignId" TEXT, "templateLabel" TEXT, "result" TEXT, "source" TEXT);
CREATE INDEX IF NOT EXISTS "OmniCreditLedger_user_at_idx" ON "OmniCreditLedger"("userId", "at");
CREATE INDEX IF NOT EXISTS "OmniCreditLedger_at_idx" ON "OmniCreditLedger"("at");
CREATE TABLE IF NOT EXISTS "OmniCreditAllowance" ("userId" TEXT NOT NULL PRIMARY KEY, "allowance" INTEGER NOT NULL, "note" TEXT, "setById" TEXT, "setByName" TEXT, "updatedAt" INTEGER NOT NULL DEFAULT 0);
