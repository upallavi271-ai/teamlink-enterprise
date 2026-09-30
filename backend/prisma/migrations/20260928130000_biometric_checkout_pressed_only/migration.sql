-- A check-out is only a check-out the person pressed. Undo the inferred
-- "latest punch = check-out" on days that have biometric punches. Data only.

-- Device punches: direction is the state key pressed (1 / 2 / 5 = check-out).
UPDATE "AttendancePunch"
SET "direction" = CASE WHEN "deviceState" IN ('1', '2', '5') THEN 'Out' ELSE 'In' END
WHERE "method" = 'Biometric' AND "deviceState" IS NOT NULL;

-- The day's stored check-out = the latest pressed check-out, or empty.
UPDATE "Attendance"
SET "checkOut" = (
  SELECT MAX(p."time") FROM "AttendancePunch" p
  WHERE p."employeeId" = "Attendance"."employeeId" AND p."date" = "Attendance"."date" AND p."direction" = 'Out'
)
WHERE EXISTS (
  SELECT 1 FROM "AttendancePunch" p
  WHERE p."employeeId" = "Attendance"."employeeId" AND p."date" = "Attendance"."date" AND p."method" = 'Biometric'
);
