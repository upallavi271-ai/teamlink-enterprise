-- Rollback of 20261017130000_omni_gs_templates_studio: drops the tables of this step only (saved RCS / Flow / voice / Studio content is lost). The OutreachTemplate columns category and extra stay (harmless, nullable).
DROP TABLE IF EXISTS "OmniStudioContent";
DROP TABLE IF EXISTS "OmniVoiceScript";
DROP TABLE IF EXISTS "OmniWaFlow";
DROP TABLE IF EXISTS "OmniRcsTemplate";
DROP TABLE IF EXISTS "OmniRcsAgent";
