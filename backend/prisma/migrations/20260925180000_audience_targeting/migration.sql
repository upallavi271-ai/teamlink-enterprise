-- Audience targeting for Employee Services / Performance (hand-written, additive).
--
-- One Send-to picker (Everyone / By department / Individual employees) is now
-- shared by every "send to people" form. The rows that carry an audience keep
-- it here. Every column is nullable, so every existing row reads exactly as
-- before: NULL departments + NULL employeeIds = the old behaviour.

ALTER TABLE "Announcement" ADD COLUMN "departments" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "employeeIds" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "delivery" TEXT;
ALTER TABLE "Announcement" ADD COLUMN "postedById" TEXT;

ALTER TABLE "Survey" ADD COLUMN "employeeIds" TEXT;
ALTER TABLE "Survey" ADD COLUMN "createdById" TEXT;

ALTER TABLE "PolicyDocument" ADD COLUMN "departments" TEXT;
ALTER TABLE "PolicyDocument" ADD COLUMN "employeeIds" TEXT;
ALTER TABLE "PolicyDocument" ADD COLUMN "createdById" TEXT;
