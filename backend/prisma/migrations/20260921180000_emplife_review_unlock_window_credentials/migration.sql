-- emplife: employee lifecycle — review outcome, bounded unlock window,
-- credential delivery record and the single-use set-password token.
--
-- HAND-WRITTEN AND ADDITIVE ON PURPOSE.
-- SQLite has no ALTER COLUMN, so Prisma implements any column *change* as a
-- table rebuild (create new / copy / drop / rename), which silently loses
-- columns other migrations added. Every statement here is a plain
-- ALTER TABLE ... ADD COLUMN; nothing is dropped, renamed or rebuilt.

-- Employee: what HR decided about the last submitted profile changes.
ALTER TABLE "Employee" ADD COLUMN "reviewDecision" TEXT;
ALTER TABLE "Employee" ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "Employee" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "reviewedByName" TEXT;

-- Employee: what HR decided about the last unlock request, and the bounded
-- window an approval grants.
ALTER TABLE "Employee" ADD COLUMN "unlockDecisionNote" TEXT;
ALTER TABLE "Employee" ADD COLUMN "unlockDecidedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "unlockExpiresAt" DATETIME;

-- Employee: whether the sign-in email really went out.
ALTER TABLE "Employee" ADD COLUMN "credentialsSentAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "credentialsSentStatus" TEXT;

-- User: the single-use, expiring set-password token. Only the SHA-256 hash of
-- the token is stored, so a database read cannot reconstruct the link.
ALTER TABLE "User" ADD COLUMN "setPasswordTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "setPasswordExpiresAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "setPasswordUsedAt" DATETIME;
