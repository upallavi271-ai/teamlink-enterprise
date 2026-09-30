-- Hand-written and additive only: new columns with defaults, two new tables.
-- (`prisma migrate diff` also proposed rebuilding unrelated tables because of
-- older drift; none of that is included here.)

-- Employee: self check-in methods Super Admin has assigned (GPS,Biometric,Face)
ALTER TABLE "Employee" ADD COLUMN "checkInMethods" TEXT;

-- Course: completion rules and how it was assigned
ALTER TABLE "Course" ADD COLUMN "requireVideos" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Course" ADD COLUMN "requireDocuments" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Course" ADD COLUMN "requireAssessment" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Course" ADD COLUMN "assignMode" TEXT;
ALTER TABLE "Course" ADD COLUMN "assignDepartments" TEXT;

-- CourseMaterial: kind, video length, required
ALTER TABLE "CourseMaterial" ADD COLUMN "kind" TEXT;
ALTER TABLE "CourseMaterial" ADD COLUMN "durationSeconds" INTEGER;
ALTER TABLE "CourseMaterial" ADD COLUMN "required" BOOLEAN NOT NULL DEFAULT true;

-- CourseAssignment: content finished, certificate
ALTER TABLE "CourseAssignment" ADD COLUMN "contentCompletedAt" DATETIME;
ALTER TABLE "CourseAssignment" ADD COLUMN "certificateId" TEXT;
ALTER TABLE "CourseAssignment" ADD COLUMN "certificateIssuedAt" DATETIME;
CREATE UNIQUE INDEX "CourseAssignment_certificateId_key" ON "CourseAssignment"("certificateId");

CREATE TABLE "CourseMaterialProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "secondsWatched" INTEGER NOT NULL DEFAULT 0,
    "lastPosition" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CourseMaterialProgress_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "CourseMaterial" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CourseMaterialProgress_materialId_employeeId_key" ON "CourseMaterialProgress"("materialId", "employeeId");
CREATE INDEX "CourseMaterialProgress_courseId_employeeId_idx" ON "CourseMaterialProgress"("courseId", "employeeId");

CREATE TABLE "EmployeeDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docName" TEXT,
    "file" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mime" TEXT,
    "size" INTEGER,
    "uploadedBy" TEXT,
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EmployeeDocument_employeeId_idx" ON "EmployeeDocument"("employeeId");
