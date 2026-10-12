-- Client portal logins: tick-box permissions (2026-10-09). ADD COLUMN only.
-- A comma list of tick keys (VIEW,REQUEST,DECIDE,INTERVIEW,FEEDBACK,AGREEMENT,INVOICES).
-- NULL = use the old portalType preset (REVIEWER / VIEWER / BILLING) or, when that is NULL too, the older full-access login.
ALTER TABLE "User" ADD COLUMN "portalPerms" TEXT;
ALTER TABLE "PortalRequest" ADD COLUMN "portalPerms" TEXT;
