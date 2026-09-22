-- hrrole_hr_role — THE HR ROLE (§6).
--
-- NO SCHEMA CHANGE AT ALL, AND DELIBERATELY SO. HR needs no new column:
-- DesignationRole.hrmsRole and User.hrmsRole already exist (added by
-- 20260921210000_prodrole_three_product_roles) and 'HR' is simply a new VALUE
-- in them. So this migration is a single INSERT — no ALTER TABLE, and above
-- all no table rebuild, which on SQLite is how a column change silently drops
-- columns that other migrations added.
--
-- WHAT IT DOES: puts the designation -> role mapping row for the HR desk in
-- the table utils/identity.js reads, so that a database which has already been
-- migrated and seeded picks up the role without being re-seeded — an
-- administrator can set an existing employee's designation to "HR" on
-- Administration -> Users and that login is HR from the next request.
--
-- The demo LOGIN for it (hr@teamlink.com / password123) comes from
-- prisma/seed.js, like every other demo account in this app. Nothing else in
-- this file creates data, because the seed is what owns the demo dataset.
--
-- The statement is INSERT ... SELECT ... WHERE NOT EXISTS, so running it
-- against a database that already has the row — including one built by
-- `migrate reset` and then seeded — changes nothing.

INSERT INTO "DesignationRole" ("id", "designation", "hrmsRole", "accountsRole", "atsRole", "hrms", "ats", "accounts", "landing", "position", "createdAt", "updatedAt")
SELECT 'desigrole_hr_desk', 'HR', 'HR', 'NONE', NULL, 1, 0, 0, 'hrms', 12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "DesignationRole" WHERE "designation" = 'HR');
