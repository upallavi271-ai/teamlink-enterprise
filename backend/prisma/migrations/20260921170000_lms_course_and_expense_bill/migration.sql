-- LMS screen + Expense bill attachment.
--
-- Plain ADD COLUMNs, hand-written. Prisma implements a column change on SQLite
-- as a table rebuild from its own fixed column list, which silently drops the
-- columns other hand-written migrations added — that has already bitten this
-- repository once. Nothing here rebuilds a table.

-- Course: the Mandatory tag and the pass mark the LMS course rows print.
ALTER TABLE "Course" ADD COLUMN "mandatory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Course" ADD COLUMN "passMark" INTEGER NOT NULL DEFAULT 70;

-- CourseAssignment: when the learner finished, so a certificate has a date.
ALTER TABLE "CourseAssignment" ADD COLUMN "completedAt" DATETIME;

-- EmployeeRecord: the bill / receipt an Expense & Travel claim carries. The
-- bytes are written outside the repository (see backend/src/utils/attachments.js);
-- only this reference is stored. `billFile` is server-generated, never the
-- client's filename.
ALTER TABLE "EmployeeRecord" ADD COLUMN "billFile" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "billName" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "billMime" TEXT;
ALTER TABLE "EmployeeRecord" ADD COLUMN "billSize" INTEGER;
