-- prodrole: one login, three independent product roles.
--
--   USER
--    ├── HRMS Role      → User.hrmsRole
--    ├── ATS Role       → User.atsRole      (already existed)
--    └── Accounts Role  → User.accountsRole
--
-- HAND-WRITTEN, AND DELIBERATELY SO. SQLite has no ALTER COLUMN, so Prisma
-- implements any column change as a table REBUILD (create new, copy, drop,
-- rename) which silently drops columns added by other migrations — that has
-- caused a real bug in this repo. Everything below is either
-- `ALTER TABLE ... ADD COLUMN` or index DDL. No table is rebuilt.

-- --------------------------------------------------------------------------
-- 1. User: the two missing product roles. `atsRole` is already there.
-- --------------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "hrmsRole" TEXT;
ALTER TABLE "User" ADD COLUMN "accountsRole" TEXT;

-- --------------------------------------------------------------------------
-- 2. DesignationRole: derivation stays in the mapping TABLE, and it must now
--    be able to carry all three roles rather than only the ATS one.
-- --------------------------------------------------------------------------
ALTER TABLE "DesignationRole" ADD COLUMN "hrmsRole" TEXT;
ALTER TABLE "DesignationRole" ADD COLUMN "accountsRole" TEXT;

-- --------------------------------------------------------------------------
-- 3. RoleAccess: the product dimension — Product → Module → Feature → Action.
--    Existing rows become the product-agnostic '*' rows, which the engine
--    still honours for every product, so nothing loses access.
--    The unique key widens by DROP INDEX / CREATE INDEX — index DDL, not a
--    table rebuild.
-- --------------------------------------------------------------------------
ALTER TABLE "RoleAccess" ADD COLUMN "product" TEXT NOT NULL DEFAULT '*';
DROP INDEX IF EXISTS "RoleAccess_role_moduleId_key";
CREATE UNIQUE INDEX "RoleAccess_role_product_moduleId_key" ON "RoleAccess"("role", "product", "moduleId");

-- --------------------------------------------------------------------------
-- 4. BACKFILL — day one must be byte-for-byte the access everyone has today.
--
-- Until now ONE column, `User.role`, decided every product. So:
--   * the HRMS role of a login that holds HRMS is exactly its `role`;
--   * the Accounts role of a login that holds Accounts is exactly its `role`;
--   * a login without the product gets 'NONE', which the engine refuses
--     outright — the same refusal the product boolean already produced.
--   * `atsRole` is left untouched: it was already a separate, derived column.
--
-- `role` keeps its own job: the ACCOUNT-LEVEL / system role (Super Admin,
-- Admin, and the external CLIENT / CANDIDATE account kinds). It is what the
-- product-agnostic surfaces — Dashboard, Reports, Administration — resolve
-- against, together with the three product roles.
-- --------------------------------------------------------------------------
UPDATE "User" SET "hrmsRole" = CASE WHEN "hrmsAccess" = 1 THEN "role" ELSE 'NONE' END
  WHERE "hrmsRole" IS NULL;
UPDATE "User" SET "accountsRole" = CASE WHEN "accountsAccess" = 1 THEN "role" ELSE 'NONE' END
  WHERE "accountsRole" IS NULL;
-- A login that holds ATS but never had a working role written keeps the one
-- the engine used for it until now: its `role`.
UPDATE "User" SET "atsRole" = "role" WHERE "atsRole" IS NULL AND "atsAccess" = 1;
UPDATE "User" SET "atsRole" = 'NONE' WHERE "atsRole" IS NULL;

-- The designation mapping, by the same rule the seed's roleForDesignation()
-- used: the login role of a designation is its ATS role, or ACCOUNTANT for an
-- accounts-only designation, or EMPLOYEE.
UPDATE "DesignationRole" SET "hrmsRole" = CASE
    WHEN "hrms" = 1 THEN COALESCE("atsRole",
      CASE WHEN "accounts" = 1 AND "ats" = 0 THEN 'ACCOUNTANT' ELSE 'EMPLOYEE' END)
    ELSE 'NONE' END
  WHERE "hrmsRole" IS NULL;
UPDATE "DesignationRole" SET "accountsRole" = CASE
    WHEN "accounts" = 1 THEN COALESCE("atsRole", 'ACCOUNTANT')
    ELSE 'NONE' END
  WHERE "accountsRole" IS NULL;
