-- auth_rbac: one employee = one user = one login.
--
-- HAND-WRITTEN ON PURPOSE. `prisma migrate dev` implements any column change on
-- SQLite as a table rebuild (create new_User, copy a FIXED column list, drop,
-- rename) which silently drops columns added by migrations it did not know
-- about — that has already bitten this repo once. Every change below is a plain
-- ALTER TABLE ... ADD COLUMN, plus one CREATE TABLE. No rebuilds.

-- User: external candidate identity.
ALTER TABLE "User" ADD COLUMN "candidateId" TEXT;

-- User: independent product access.
ALTER TABLE "User" ADD COLUMN "hrmsAccess" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "atsAccess" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "accountsAccess" BOOLEAN NOT NULL DEFAULT false;

-- User: derived ATS working role and data scope.
ALTER TABLE "User" ADD COLUMN "atsRole" TEXT;
ALTER TABLE "User" ADD COLUMN "atsScopeDepartments" TEXT;
ALTER TABLE "User" ADD COLUMN "atsScopeTeams" TEXT;
ALTER TABLE "User" ADD COLUMN "atsScopeClients" TEXT;
ALTER TABLE "User" ADD COLUMN "landingWorkspace" TEXT;

-- Designation -> ATS role mapping. Configurable data, not a switch statement.
CREATE TABLE "DesignationRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "designation" TEXT NOT NULL,
    "atsRole" TEXT,
    "hrms" BOOLEAN NOT NULL DEFAULT true,
    "ats" BOOLEAN NOT NULL DEFAULT false,
    "accounts" BOOLEAN NOT NULL DEFAULT false,
    "landing" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DesignationRole_designation_key" ON "DesignationRole"("designation");

-- Backfill product access for logins that already exist, from their role code,
-- so no existing login loses anything on upgrade.
UPDATE "User" SET "hrmsAccess" = true
  WHERE "role" IN ('SUPER_ADMIN','ADMIN','MANAGER','ASSISTANT_MANAGER','STL','TL','RECRUITER','BDE','ACCOUNTANT','EMPLOYEE');
UPDATE "User" SET "atsAccess" = true
  WHERE "role" IN ('SUPER_ADMIN','ADMIN','MANAGER','ASSISTANT_MANAGER','STL','TL','RECRUITER','BDE','CLIENT');
UPDATE "User" SET "accountsAccess" = true
  WHERE "role" IN ('SUPER_ADMIN','ADMIN','MANAGER','ACCOUNTANT','CLIENT');
UPDATE "User" SET "atsRole" = "role"
  WHERE "role" IN ('SUPER_ADMIN','ADMIN','MANAGER','ASSISTANT_MANAGER','STL','TL','RECRUITER','BDE','CLIENT');
