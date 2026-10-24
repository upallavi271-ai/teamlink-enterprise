-- Rollback of 20261022120000_wa_template_waba.
-- The per-account template status is deleted. Templates, their summary status (OutreachTemplate.waApprovalStatus / extra.meta) and the
-- WhatsApp numbers are untouched; sending goes back to the single status per template.
DROP TABLE IF EXISTS "WaTemplateWaba";
