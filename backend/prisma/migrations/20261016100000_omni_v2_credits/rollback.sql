-- Rollback of 20261016100000_omni_v2_credits (the ledger is deleted: take a copy first if the history matters)
DROP TABLE IF EXISTS "OmniCreditLedger";
DROP TABLE IF EXISTS "OmniCreditAllowance";
