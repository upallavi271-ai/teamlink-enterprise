-- HRMS-24 §14-§24 LMS (hand-written, additive).
--
-- Assessment rules on a course, the assignment audit (who assigned what to
-- whom, due date) and the completion record on each enrolment, per-PDF page
-- tracking on material progress, one row per "assign" action and one row per
-- assessment attempt. Every new column is nullable or defaulted, so every
-- existing row reads exactly as before.

ALTER TABLE "Course" ADD COLUMN "questionsPerAttempt" INTEGER;
ALTER TABLE "Course" ADD COLUMN "timeLimitMinutes" INTEGER;
ALTER TABLE "Course" ADD COLUMN "maxAttempts" INTEGER;
ALTER TABLE "Course" ADD COLUMN "randomizeQuestions" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "CourseAssignment" ADD COLUMN "assignedById" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "assignedByName" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "source" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "department" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "batchId" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "dueDate" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "lastAccessedAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "assessmentStartedAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "assessmentCompletedAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "passedAttempt" INTEGER;
ALTER TABLE "CourseAssignment" ADD COLUMN "certificateEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CourseAssignment" ADD COLUMN "extraAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CourseMaterialProgress" ADD COLUMN "firstViewedAt" DATETIME;
ALTER TABLE "CourseMaterialProgress" ADD COLUMN "pagesViewed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CourseMaterialProgress" ADD COLUMN "pageCount" INTEGER;

-- Existing completed enrolments were certified when they completed.
UPDATE "CourseAssignment" SET "certificateEligible" = true WHERE "completed" = true;

CREATE TABLE "CourseAssignmentBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "departments" TEXT,
    "employeeIds" TEXT,
    "label" TEXT,
    "assignedById" TEXT,
    "assignedByName" TEXT,
    "assignedByRole" TEXT,
    "orgWide" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" DATETIME,
    "assignedCount" INTEGER NOT NULL DEFAULT 0,
    "alreadyCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CourseAssignmentBatch_courseId_idx" ON "CourseAssignmentBatch"("courseId");

CREATE TABLE "CourseAssessmentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assignmentId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "questionIds" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "submittedAt" DATETIME,
    "score" INTEGER,
    "correct" INTEGER,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN,
    "timedOut" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "CourseAssessmentAttempt_assignmentId_idx" ON "CourseAssessmentAttempt"("assignmentId");
CREATE INDEX "CourseAssessmentAttempt_courseId_employeeId_idx" ON "CourseAssessmentAttempt"("courseId", "employeeId");
