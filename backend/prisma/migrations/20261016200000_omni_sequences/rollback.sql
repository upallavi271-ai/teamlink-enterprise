-- Rollback of 20261016200000_omni_sequences (the data in these tables is deleted; the OutreachCampaign.kind column, if present, is left alone)
DROP TABLE IF EXISTS "OmniSequenceLog";
DROP TABLE IF EXISTS "OmniSequenceRun";
DROP TABLE IF EXISTS "OmniSequence";
DROP TABLE IF EXISTS "OmniRecharge";
