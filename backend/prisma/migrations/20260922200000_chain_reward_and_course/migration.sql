-- chain_reward_and_course
--
-- §13 and §14 put a PERFORMANCE RECOMMENDATION and a COURSE on the same
-- approval ladder as leave. Both rows needed somewhere to sit while they climb
-- it, because until now a review was an award the moment it was typed and a
-- course was in front of the company the moment it was saved.
--
-- FOUR PLAIN ADD COLUMNs, hand-written. Prisma implements a column change on
-- SQLite as a table REBUILD (create new_X, copy a fixed column list, drop,
-- rename) which silently drops columns other migrations added; ADD COLUMN
-- cannot.
--
-- THE DEFAULT IS 'Approved' ON PURPOSE. Every review and every course that
-- already exists stays exactly as it is — visible, assignable, unchanged. The
-- chain only ever holds back a row raised AFTER this shipped by somebody the
-- ladder has rungs above, which is what "do not break what works" means here.

-- §13 — a recommendation is not an award until the chain says so.
ALTER TABLE "PerformanceReview" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'Approved';
-- Who raised it. The chain is resolved from the SUBJECT employee, but the
-- applicant is whoever recommended them — usually their TL — and that is who
-- may not approve their own recommendation.
ALTER TABLE "PerformanceReview" ADD COLUMN "raisedById" TEXT;

-- §14 — a course is a DRAFT until the chain approves publication.
ALTER TABLE "Course" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'Approved';
ALTER TABLE "Course" ADD COLUMN "raisedById" TEXT;
