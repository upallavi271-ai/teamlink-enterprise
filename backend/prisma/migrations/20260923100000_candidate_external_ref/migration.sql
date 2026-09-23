-- candidate_external_ref
--
-- A STABLE IDENTIFIER FOR A CANDIDATE WITH NO CONTACT DETAILS.
--
-- The importer keys a candidate on email, or on phone where there is no
-- email, so that re-importing a corrected file updates people instead of
-- duplicating them. Several of the company's real sheets — the education
-- profile screening (7,833 rows), the medical schedule and interview sheets
-- (3,100) and the manufacturing ones (830) — HAVE NO CONTACT COLUMN AT ALL.
-- They record a name, a qualification, a branch, an experience and a
-- location, and nothing else.
--
-- Keyed on name alone, two different people called Priyanka become one
-- person. Not imported at all, 12,033 rows of real interview history are
-- thrown away. Neither is acceptable, so the source supplies a reference
-- derived from the fields it DOES have, and the importer keys on that.
--
-- Nullable, and only ever set for rows that arrive without an email or a
-- phone — everybody already in the system is untouched and still keyed the
-- way they were.

ALTER TABLE "Candidate" ADD COLUMN "externalRef" TEXT;

-- Not UNIQUE: a candidate could legitimately be re-keyed later, and a unique
-- index would turn that into a failed import rather than an update. The index
-- is for lookup speed, which is what the importer needs.
CREATE INDEX "Candidate_externalRef_idx" ON "Candidate"("externalRef");
