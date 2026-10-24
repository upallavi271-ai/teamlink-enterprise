-- Undo of 20261014100000_outreach_core (drops only the tables that migration created).
DROP TABLE IF EXISTS "OutreachSendLog";
DROP TABLE IF EXISTS "OutreachTemplate";
DROP TABLE IF EXISTS "OutreachSegment";
DROP TABLE IF EXISTS "OutreachImport";
DROP TABLE IF EXISTS "OutreachSuppression";
DROP TABLE IF EXISTS "OutreachConsentEvent";
DROP TABLE IF EXISTS "OutreachContactChannel";
DROP TABLE IF EXISTS "OutreachContactTag";
DROP TABLE IF EXISTS "OutreachContact";
