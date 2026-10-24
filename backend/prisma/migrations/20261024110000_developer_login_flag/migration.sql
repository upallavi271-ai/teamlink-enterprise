-- DEVELOPER-TEAM LOGIN (founder, 2026-10-24). Additive only: one new column, every existing login keeps false.
--   User.internalAccount   true for a developer / system login that is NOT a member of staff: it has no employee record, and what it does
--                          (sign-ins, activity) is kept out of the dashboards' "recent activity" and the login counts. It is still listed in
--                          Administration -> Users and in the Audit logs, so the Super Admin can always see and switch it off.
ALTER TABLE "User" ADD COLUMN "internalAccount" BOOLEAN NOT NULL DEFAULT false;
