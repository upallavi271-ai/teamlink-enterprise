-- lms_materials_assessment — the Course Materials, Manage Assessment and
-- Enrolled Employees panels.
--
-- TWO NEW TABLES AND FOUR PLAIN ADD COLUMNs, all hand-written. Prisma
-- implements a column change on SQLite as a table REBUILD (create new_X, copy
-- a fixed column list, drop, rename), and such a rebuild silently drops
-- columns that other migrations added. CREATE TABLE and ALTER TABLE ... ADD
-- COLUMN cannot do that, so nothing here is generated.

-- A file or link attached to a course. `storedPath` is where the upload
-- landed; `url` is used instead when the material is a link rather than a
-- file, so both kinds live in one list.
CREATE TABLE "CourseMaterial" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "courseId"   TEXT NOT NULL,
  "title"      TEXT NOT NULL,
  "fileName"   TEXT,
  "storedPath" TEXT,
  "mimeType"   TEXT,
  "sizeBytes"  INTEGER,
  "url"        TEXT,
  "uploadedBy" TEXT,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseMaterial_courseId_fkey" FOREIGN KEY ("courseId")
    REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CourseMaterial_courseId_idx" ON "CourseMaterial"("courseId");

-- One multiple-choice question in a course's question bank.
--
-- `correctIndex` IS THE ANSWER AND IT NEVER LEAVES THE SERVER on a learner
-- request: /lms/courses/:id/assessment strips it for anyone taking the
-- assessment and returns it only to whoever may manage the course. Shuffling
-- is done per attempt for the same reason.
CREATE TABLE "AssessmentQuestion" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "courseId"     TEXT NOT NULL,
  "question"     TEXT NOT NULL,
  "options"      TEXT NOT NULL,          -- JSON array of option strings
  "correctIndex" INTEGER NOT NULL,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssessmentQuestion_courseId_fkey" FOREIGN KEY ("courseId")
    REFERENCES "Course" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssessmentQuestion_courseId_idx" ON "AssessmentQuestion"("courseId");

-- Per-enrolment progress. "Video watch time: Not started" on the Enrolled
-- Employees panel reads watchedSeconds; the score columns record the last
-- assessment attempt.
ALTER TABLE "CourseAssignment" ADD COLUMN "watchedSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CourseAssignment" ADD COLUMN "score" INTEGER;
ALTER TABLE "CourseAssignment" ADD COLUMN "scoredAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
