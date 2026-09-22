-- followup_outcome_and_escalation
--
-- Completing a follow-up used to take one free-text note, so "what happened"
-- and "what next" were whatever the owner chose to type — or did not. Both are
-- now RECORDED CHOICES, and the escalation ladder gains the three levels it was
-- missing.
--
-- NINE PLAIN ADD COLUMNs, hand-written. Prisma implements a column change on
-- SQLite as a table REBUILD (create new_X, copy a fixed column list, drop,
-- rename) which silently drops columns other migrations added; ADD COLUMN
-- cannot. Every column is nullable or defaulted, so existing rows are valid
-- exactly as they stand and no backfill is needed.

-- §8 "What happened?" and §4 the call result, both from a fixed list.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "outcome" TEXT;
-- §9 "What should happen next?" — the chosen next step, beside the free text.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "nextStep" TEXT;
-- §9 next follow-up TIME. `nextFollowUpAt` is a date; a 3:00 PM callback needs
-- the clock as well as the day.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "nextFollowUpTime" TEXT;
-- The due TIME, for the same reason: "Due: 11:00 AM" in §11.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "dueTime" TEXT;
-- §18-§20 — a follow-up the SYSTEM raised at a stage change, not a person.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "autoCreated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "purpose" TEXT;

-- §11-§13 — the ladder is Owner -> TL -> STL -> Admin -> Super Admin. Only TL
-- and Admin existed. `escalationLevel` is the CURRENT rung, so a dashboard can
-- group by it without re-deriving from four timestamps.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "stlUserId" TEXT;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "stlName" TEXT;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "escalatedStlAt" DATETIME;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "escalatedSuperAdminAt" DATETIME;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "escalationLevel" INTEGER NOT NULL DEFAULT 0;
