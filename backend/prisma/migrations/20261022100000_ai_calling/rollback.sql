-- Rollback of 20261022100000_ai_calling (every AI call row, event, offer, job switch, do-not-call number, campaign and language preference is DELETED; nothing else is touched)
DROP TABLE IF EXISTS "AiCallPref";
DROP TABLE IF EXISTS "AiCallCampaign";
DROP TABLE IF EXISTS "AiCallSuppression";
DROP TABLE IF EXISTS "AiCallJobSetting";
DROP TABLE IF EXISTS "AiCallOffer";
DROP TABLE IF EXISTS "AiCallEvent";
DROP TABLE IF EXISTS "AiCall";
