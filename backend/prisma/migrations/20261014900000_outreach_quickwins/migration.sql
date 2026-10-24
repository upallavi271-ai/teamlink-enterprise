-- Omni-Channel Outreach, quick wins (user go 2026-10-14): campaign notes (why a campaign stopped / paused / finished, used for the bell
-- notifications so the same thing is never announced twice) and the per-row result of a contact import (for the "rows with problems" file).
-- ADDITIVE ONLY: two new tables, nothing existing is altered. DateTime columns hold epoch milliseconds.
-- The application reads and writes these with plain SQL (src/outreach/*) and feature-detects them: until this migration is applied the
-- banners are still worked out live from the settings and the queue, and an import hands its results back directly (no saved copy).
-- Undo: rollback.sql (DROP TABLE of the two tables below).

-- one line per thing worth telling: noteKey is UNIQUE (campaign + kind + a stamp), so a repeat tick announces nothing twice. No names, phones or emails.
CREATE TABLE "OutreachCampaignNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "noteKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,                 -- finished | stopped | paused | held | failed
    "reason" TEXT,                        -- a code (daily_cap, sending_off, test_mode, mail_not_set_up, ...)
    "text" TEXT,                          -- the plain sentence shown on the campaign
    "at" DATETIME NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "OutreachCampaignNote_key" ON "OutreachCampaignNote"("noteKey");
CREATE INDEX "OutreachCampaignNote_campaign_idx" ON "OutreachCampaignNote"("campaignId", "at");

-- what happened to each row of an import (row number, a result word, a reason in words). The person's name only; no phone, no email.
CREATE TABLE "OutreachImportRow" (
    "importId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "name" TEXT,
    "result" TEXT NOT NULL,               -- created | updated | skipped | conflict | failed
    "why" TEXT,
    "look" INTEGER NOT NULL DEFAULT 0,     -- 1 = this row needs a person to look at it (not a clean added / changed row)
    PRIMARY KEY ("importId", "line")
);
