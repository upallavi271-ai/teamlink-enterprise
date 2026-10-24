-- UPLOAD APPROVALS (founder, 2026-10-24): what a TL or HR uploads in Documents and in the LMS climbs the approval chain to the Super Admin before
-- anybody else sees it. Additive only: three new columns, every existing row keeps its meaning ('Approved' = already published, as before).
--   PolicyDocument.approvalStatus   Approved | Pending | Rejected   (a Pending / Rejected document is never published to employees)
--   PolicyDocument.pendingChannels  the "tell them by ..." choice made at upload, used when the last approver says yes
--   CourseMaterial.approvalStatus   Approved | Pending | Rejected   (a Pending material is hidden from learners; the course stays live without it)
ALTER TABLE "PolicyDocument" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'Approved';
ALTER TABLE "PolicyDocument" ADD COLUMN "pendingChannels" TEXT;
ALTER TABLE "CourseMaterial" ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'Approved';
