-- Omni-Channel Green Start rebuild: Dashboard (Overview) + Analytics & Reports page.
-- ONE small table: which dashboard insight a person hid for 7 days (a person clicks "Dismiss" on an insight). Everything else on these two pages is READ
-- from existing tables (OutreachCampaign / OutreachMessage / OutreachEvent / OutreachContact, OmniCreditLedger, ATS applications), so nothing else is added.
-- Raw-SQL table, no Prisma model; the app also creates it itself with IF NOT EXISTS (outreach/overview.js) the first time it is needed.
CREATE TABLE IF NOT EXISTS "OmniInsightDismiss" ("userId" TEXT NOT NULL, "key" TEXT NOT NULL, "until" INTEGER NOT NULL DEFAULT 0, "at" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("userId", "key"));
