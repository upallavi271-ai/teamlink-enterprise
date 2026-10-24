-- Rollback of 20261017100000_omni_v3_library_forms. The data in these tables is deleted (uploaded library files stay in the upload folder).
-- The nullable columns the app added to OutreachContact / OutreachCampaign / OutreachMessage / OutreachSegment / OutreachTemplate are harmless and are left alone
-- (SQLite cannot drop them safely on a table with data); the older code simply never reads them.
DROP TABLE IF EXISTS "OmniFormSubmission";
DROP TABLE IF EXISTS "OmniForm";
DROP TABLE IF EXISTS "OmniLibrary";
