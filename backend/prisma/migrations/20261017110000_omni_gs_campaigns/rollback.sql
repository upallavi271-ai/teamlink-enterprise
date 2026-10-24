-- Rollback of 20261017110000_omni_gs_campaigns. The activity trail is deleted (the campaigns and their messages are not touched).
-- The nullable columns the app added to OutreachCampaign / OutreachMessage are harmless and are left alone (SQLite cannot drop them safely on a table with data).
DROP TABLE IF EXISTS "OmniCampaignActivity";
