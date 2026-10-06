-- Resume file storage + versions (resume_). ONE NEW TABLE; no existing table is
-- altered, so the SQLite table-rebuild trap cannot fire. See schema.prisma.
CREATE TABLE "CandidateResume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseResumeId" TEXT,
    "file" TEXT,
    "fileName" TEXT,
    "mime" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "docxFile" TEXT,
    "text" TEXT,
    "sections" TEXT,
    "parsed" TEXT,
    "parser" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateResume_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CandidateResume_candidateId_kind_idx" ON "CandidateResume"("candidateId", "kind");
