-- Omni-Channel > Campaigns (2026-10-17, the Green Start rebuild): the campaign ACTIVITY trail (what a person did to a campaign: made it, asked for approval, approved,
-- sent it back, scheduled, paused, resumed, stopped, resent the failed ones, copied it). Messages going out are NOT written here: they are counted from OutreachMessage.
-- Raw-SQL table, no Prisma model; the app also creates it itself with IF NOT EXISTS (outreach/campaignActivity.js).
-- COLUMNS ARE NOT IN THIS FILE ON PURPOSE (same reason as 20261017100000_omni_v3_library_forms: SQLite has no ADD COLUMN IF NOT EXISTS and the app adds them itself
-- on first use, guarded by PRAGMA table_info, in outreach/v3schema.js). The columns this area relies on (all nullable, nothing removed or changed):
--   OutreachCampaign  meta (JSON: channel, groupId, groupName, objective, tag, goal, masterMessage, cta, varMap, department, approvalMode, when, at ...), approval ('waiting' | 'approved' | 'changes'), perMinute, kind
--   OutreachMessage   repliedAt, callMinutes, readAt
-- A CALL campaign keeps its real channel in OutreachCampaign.meta (the table CHECK only allows email | whatsapp | sms); its call tasks are OutreachMessage rows with channel 'call'.
CREATE TABLE IF NOT EXISTS "OmniCampaignActivity" ("id" TEXT NOT NULL PRIMARY KEY, "campaignId" TEXT NOT NULL, "groupId" TEXT, "at" DATETIME NOT NULL DEFAULT 0, "kind" TEXT NOT NULL, "text" TEXT NOT NULL, "byId" TEXT, "byName" TEXT);
CREATE INDEX IF NOT EXISTS "OmniCampaignActivity_campaign_idx" ON "OmniCampaignActivity"("campaignId", "at");
CREATE INDEX IF NOT EXISTS "OmniCampaignActivity_group_idx" ON "OmniCampaignActivity"("groupId", "at");
