-- Application.ownerRecruiterId: the recruiter whose candidate this is (founder 2026-10-26)
ALTER TABLE "Application" ADD COLUMN "ownerRecruiterId" TEXT;
CREATE INDEX "Application_ownerRecruiterId_idx" ON "Application"("ownerRecruiterId");

-- Existing applications: the first RECRUITER who moved it, when that recruiter is still on the requirement. The rest stay
-- unowned (every recruiter on the requirement keeps seeing them, as before).
UPDATE "Application" SET "ownerRecruiterId" = (
  SELECT e."actorUserId" FROM "ApplicationStageEvent" e
  JOIN "Requirement" r ON r."id" = "Application"."requirementId"
  WHERE e."applicationId" = "Application"."id" AND e."actorRole" = 'RECRUITER' AND e."actorUserId" IS NOT NULL
    AND (r."recruiterId" = e."actorUserId" OR instr(COALESCE(r."recruiterIds", ''), e."actorUserId") > 0)
  ORDER BY e."createdAt" ASC LIMIT 1
);
