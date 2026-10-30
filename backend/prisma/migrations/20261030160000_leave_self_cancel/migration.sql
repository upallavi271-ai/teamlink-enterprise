-- Employee cancels their own leave (founder 2026-10-30): who, when and why stay on the request for its history.
ALTER TABLE "LeaveRequest" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "LeaveRequest" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "LeaveRequest" ADD COLUMN "cancelReason" TEXT;
