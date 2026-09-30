-- Organisation structure on Position (hand-written, additive).
--
-- Department -> Team -> Position (TL / Recruiter / STL) -> holder.
--   kind         TL | RECRUITER | STL | OTHER. What the seat IS in the
--                structure; the scope engine reads it (utils/positionScope.js).
--   reportsToId  the seat this one reports to: a recruiter seat -> its team's
--                TL seat, a TL seat -> the STL seat (if any). A plain scalar,
--                the same pattern Requirement.tlId uses, so this stays
--                ADD COLUMN only.
-- `team` already existed and now carries "Team A" / "Team B" / "Team".
-- Every existing row reads kind = OTHER and reports to nobody until the
-- structure is set, i.e. exactly as before.

ALTER TABLE "Position" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE "Position" ADD COLUMN "reportsToId" TEXT;
CREATE INDEX "Position_reportsToId_idx" ON "Position"("reportsToId");
