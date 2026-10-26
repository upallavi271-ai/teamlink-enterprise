-- Marked attendance times changed by the Super Admin (or HR when allowed) stand over the punches (2026-10-26)
ALTER TABLE "Attendance" ADD COLUMN "timesSetBy" TEXT;
ALTER TABLE "Attendance" ADD COLUMN "timesSetAt" DATETIME;
