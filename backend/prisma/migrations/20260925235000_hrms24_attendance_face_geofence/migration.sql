-- HRMS-24 §4/§5/§10/§11 attendance (hand-written, additive).
--
-- The missing-check-in rule and weekly offs used to derive a day's status,
-- the Super Admin geofence and face-match threshold for web/mobile check-in,
-- and on each punch what that check-in captured: location, the stored live
-- image, the verification result and the device's user agent. Every new
-- column is nullable or defaulted, so every existing row reads as before.

ALTER TABLE "HrConfig" ADD COLUMN "missingCheckInRule" TEXT NOT NULL DEFAULT 'Missing Check-In';
ALTER TABLE "HrConfig" ADD COLUMN "weeklyOffDays" TEXT NOT NULL DEFAULT '0,6';
ALTER TABLE "HrConfig" ADD COLUMN "geofenceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "HrConfig" ADD COLUMN "officeLatitude" REAL;
ALTER TABLE "HrConfig" ADD COLUMN "officeLongitude" REAL;
ALTER TABLE "HrConfig" ADD COLUMN "geofenceRadiusM" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "HrConfig" ADD COLUMN "faceMatchThreshold" REAL NOT NULL DEFAULT 0.45;

ALTER TABLE "AttendancePunch" ADD COLUMN "source" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "latitude" REAL;
ALTER TABLE "AttendancePunch" ADD COLUMN "longitude" REAL;
ALTER TABLE "AttendancePunch" ADD COLUMN "accuracyM" REAL;
ALTER TABLE "AttendancePunch" ADD COLUMN "locationAt" DATETIME;
ALTER TABLE "AttendancePunch" ADD COLUMN "locationStatus" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "distanceM" REAL;
ALTER TABLE "AttendancePunch" ADD COLUMN "imageFile" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "verificationScore" REAL;
ALTER TABLE "AttendancePunch" ADD COLUMN "livenessStatus" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "userAgent" TEXT;
