-- Dynamic roles (Role & Permission Management). Hand-written and ADDITIVE:
-- one new table. Written IF NOT EXISTS so it is idempotent — it was applied
-- to dev.db with `prisma db execute` while the backend was running (the
-- schema engine could not take its lock), and `migrate deploy` then records
-- it without error. The 13 system roles are seeded by the backend on first
-- use (utils/roleRegistry.js ensureSystemRoles), not here.
CREATE TABLE IF NOT EXISTS "Role" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "scopeLevel" TEXT NOT NULL DEFAULT 'OWN',
    "behavesLike" TEXT,
    "permissions" TEXT,
    "products" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Role_code_key" ON "Role"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "Role_name_key" ON "Role"("name");
