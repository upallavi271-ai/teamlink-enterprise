-- SAME WHATSAPP TEMPLATE FOR EVERY NUMBER (2026-10-22). Additive only: one new table, nothing existing is altered.
--   WaTemplateWaba  one row per (template, WhatsApp Business Account): what Meta said about THIS template in THIS account
--                   (status draft | pending | approved | rejected, Meta's template id, the reason Meta gave, when it was sent / last checked).
--                   Numbers inside one account share the row; a number of another account needs its own approved copy.
--                   Only Meta's own answer is ever written here (outreach/tplWaba.js); the column OutreachTemplate.waApprovalStatus stays
--                   as the summary ("approved on at least one account").
-- The same statements run by themselves (CREATE ... IF NOT EXISTS) the first time an Admin presses "Send to every number's WhatsApp account"
-- (outreach/tplWaba.js ensure()), so "prisma migrate deploy" afterwards is a no-op. With no row here everything works exactly as before.

CREATE TABLE IF NOT EXISTS "WaTemplateWaba" (
    "templateId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "metaId" TEXT,
    "metaStatus" TEXT,
    "reason" TEXT,
    "submittedAt" TEXT,
    "checkedAt" TEXT,
    "updatedAt" TEXT NOT NULL,
    PRIMARY KEY ("templateId", "wabaId")
);
CREATE INDEX IF NOT EXISTS "WaTemplateWaba_waba" ON "WaTemplateWaba"("wabaId", "status");
