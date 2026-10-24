-- Undo of 20261014200000_outreach_campaigns (drops only the tables that migration created).
DROP TABLE IF EXISTS "OutreachRunnerLease";
DROP TABLE IF EXISTS "OutreachWebhookReceipt";
DROP TABLE IF EXISTS "OutreachEvent";
DROP TABLE IF EXISTS "OutreachMessage";
DROP TABLE IF EXISTS "OutreachCampaign";
