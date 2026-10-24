-- 20261017150000_omni_gs_admin: Omni-Channel Administration pages (Team & Roles, Billing, Super Admin, Settings, organisation modal).
-- NO new tables or columns: everything is kept in the existing AppSetting rows (omni.departments, omni.permissions, omni.credits, omni.approval,
-- omni.consentRules, omni.waNumbers, omni.bots, outreach.settings), the credit tables of 20261016100000_omni_v2_credits and the AuditLog.
-- This file is kept so the migration history shows the step; it changes nothing.
SELECT 1;
