-- Rollback of 20261017140000_omni_gs_automation_bots (bot flows and their log are deleted)
DROP TABLE IF EXISTS "OmniBotConv";
DROP TABLE IF EXISTS "OmniBotLog";
DROP TABLE IF EXISTS "OmniBotFlow";
