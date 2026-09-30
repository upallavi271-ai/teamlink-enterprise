-- What the biometric device said about each punch. Additive only.
ALTER TABLE "AttendancePunch" ADD COLUMN "deviceState" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "deviceVerify" TEXT;
ALTER TABLE "AttendancePunch" ADD COLUMN "clockTime" TEXT;

-- Fill them for punches that already came from the device, from the raw log.
UPDATE "AttendancePunch"
SET "deviceState"  = (SELECT l."statusCode" FROM "BiometricPunchLog" l WHERE l."attendancePunchId" = "AttendancePunch"."id"),
    "deviceVerify" = (SELECT l."verifyCode" FROM "BiometricPunchLog" l WHERE l."attendancePunchId" = "AttendancePunch"."id"),
    "clockTime"    = (SELECT substr(l."punchAt", 12, 8) FROM "BiometricPunchLog" l WHERE l."attendancePunchId" = "AttendancePunch"."id")
WHERE EXISTS (SELECT 1 FROM "BiometricPunchLog" l WHERE l."attendancePunchId" = "AttendancePunch"."id");

-- Their direction follows the key pressed on the device: 1 / 2 / 5 are check-out states.
UPDATE "AttendancePunch"
SET "direction" = CASE WHEN "deviceState" IN ('1', '2', '5') THEN 'Out' ELSE 'In' END
WHERE "deviceState" IS NOT NULL;
