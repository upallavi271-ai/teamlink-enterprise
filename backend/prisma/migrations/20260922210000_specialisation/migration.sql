-- specialisation
--
-- THE SECOND LEVEL OF THE HIERARCHY: Department -> Specialisation.
--
--   Medical -> MBBS, Dermatology, Gynaecology, Paediatrics, Cardiology
--
-- Candidate.specialization already existed as free text, which is why the
-- same specialisation could be spelled three ways and never group in a
-- report. This gives a department its LIST, so a requirement and a candidate
-- pick from the same set and "Medical -> Dermatology -> Candidates" is a real
-- filter rather than a string match that mostly works.
--
-- One new table and one plain ADD COLUMN, hand-written. Prisma implements a
-- column change on SQLite as a table REBUILD which silently drops columns
-- other migrations added; ADD COLUMN cannot.

CREATE TABLE "Specialisation" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "name"         TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Specialisation_departmentId_fkey" FOREIGN KEY ("departmentId")
    REFERENCES "Department" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- A department cannot list the same specialisation twice.
CREATE UNIQUE INDEX "Specialisation_departmentId_name_key" ON "Specialisation"("departmentId", "name");

-- A requirement's specialisation. Nullable: most departments do not use one,
-- and every requirement that already exists is valid exactly as it stands.
ALTER TABLE "Requirement" ADD COLUMN "specialisation" TEXT;
