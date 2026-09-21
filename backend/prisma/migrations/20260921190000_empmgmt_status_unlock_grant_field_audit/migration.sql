-- empmgmt: the unambiguous profile-status vocabulary, a recorded edit-access
-- grant, and a per-field approval trail.
--
-- HAND-WRITTEN AND ADDITIVE ON PURPOSE.
-- SQLite has no ALTER COLUMN, so Prisma implements any column *change* as a
-- table rebuild (create new / copy / drop / rename), which silently loses
-- columns other migrations added — that has already caused a real bug in this
-- repo. Every schema statement below is a plain ALTER TABLE ... ADD COLUMN.
-- Nothing is dropped, renamed or rebuilt. The UPDATEs at the end only rewrite
-- VALUES in an existing column, which SQLite does in place.

-- --------------------------------------------------------------------------
-- 1. Edit-access grants become a record, not just an expiry timestamp.
--    "Who unlocked this profile, when, why, and which section did they open?"
--    used to be answerable only by reading the audit log's free text.
-- --------------------------------------------------------------------------
ALTER TABLE "Employee" ADD COLUMN "unlockedById" TEXT;
ALTER TABLE "Employee" ADD COLUMN "unlockedByName" TEXT;
ALTER TABLE "Employee" ADD COLUMN "unlockedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "unlockGrantReason" TEXT;
ALTER TABLE "Employee" ADD COLUMN "unlockGrantSection" TEXT;

-- --------------------------------------------------------------------------
-- 2. The audit log grows the columns a FIELD-LEVEL history needs:
--    Employee · Field · Old Value · New Value · Changed By · Changed At ·
--    Reason · Approval Status (and who approved it, and when).
--    `fromValue` / `toValue` already carry old/new; `userId` / `createdAt`
--    already carry changed-by / changed-at. These close the rest.
-- --------------------------------------------------------------------------
ALTER TABLE "AuditLog" ADD COLUMN "field" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "fieldLabel" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "reason" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "approvalStatus" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "approvedByName" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "approvedAt" DATETIME;
-- The actor's name is snapshotted so a later rename (or a deleted login) does
-- not rewrite history.
ALTER TABLE "AuditLog" ADD COLUMN "actorName" TEXT;

-- --------------------------------------------------------------------------
-- 3. Profile status vocabulary.
--    Employee.profileStage used three values (Assigned / Pending Review /
--    Locked). The agreed vocabulary is six:
--      Profile Incomplete · Pending Review · Approved · Locked ·
--      Change Requested · Edit Access Granted
--    Existing rows are MIGRATED, not orphaned. The column keeps its name and
--    its type, so this is a value rewrite only.
--
--    Order matters: the more specific cases are rewritten before the
--    catch-all, and each UPDATE is guarded so it cannot touch a row another
--    one already claimed.
-- --------------------------------------------------------------------------

-- Assigned + HR sent it back with a reason -> Change Requested.
UPDATE "Employee" SET "profileStage" = 'Change Requested'
 WHERE "profileStage" = 'Assigned' AND "reviewDecision" = 'Rejected';

-- Assigned + an unlock window HR granted is still open -> Edit Access Granted.
UPDATE "Employee" SET "profileStage" = 'Edit Access Granted'
 WHERE "profileStage" = 'Assigned'
   AND "unlockExpiresAt" IS NOT NULL
   AND "unlockExpiresAt" > CURRENT_TIMESTAMP;

-- Assigned + already approved once, currently unlocked -> Approved.
UPDATE "Employee" SET "profileStage" = 'Approved'
 WHERE "profileStage" = 'Assigned' AND "reviewDecision" = 'Approved';

-- Everything else that was 'Assigned' is a profile nobody has filled in yet.
UPDATE "Employee" SET "profileStage" = 'Profile Incomplete'
 WHERE "profileStage" = 'Assigned';

-- 'Pending Review' and 'Locked' already match the new vocabulary and are left
-- exactly as they are. A NULL/blank stage (possible on a hand-inserted row) is
-- given the safe starting value rather than left to render as an empty badge.
UPDATE "Employee" SET "profileStage" = 'Profile Incomplete'
 WHERE "profileStage" IS NULL OR TRIM("profileStage") = '';
