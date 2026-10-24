-- Undo of 20261017200000_omni_integration (drops the integration tables; the data in them is lost).
DROP TABLE IF EXISTS "OmniAppCampaignItem";
DROP TABLE IF EXISTS "OmniAppCampaign";
DROP TABLE IF EXISTS "OmniReplyLink";
DROP TABLE IF EXISTS "OmniProviderEvent";
DROP TABLE IF EXISTS "OmniTemplateVersion";
DROP TABLE IF EXISTS "OmniTemplateMeta";
