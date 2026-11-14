-- Joining targets split by category (founder 2026-11-14). Additive: one new table.
CREATE TABLE "JoiningCategoryTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fromMonth" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "incentive" REAL,
    "note" TEXT,
    "setById" TEXT,
    "setByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "JoiningCategoryTarget_department_category_fromMonth_key" ON "JoiningCategoryTarget"("department", "category", "fromMonth");

-- The Medical team's monthly count, as the founder gave it on 2026-11-14 (15 joinings in all), from November 2026.
-- No incentive amount was given, so none is recorded: the amount stays empty until Super Admin sets it.
INSERT INTO "JoiningCategoryTarget" ("id", "department", "category", "fromMonth", "target", "incentive", "note", "setById", "setByName", "createdAt", "updatedAt")
VALUES
  ('jct_medical_md_ms_doctor_ft',  'Medical', 'MD_MS_DOCTOR_FT',  '2026-11', 1, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  ('jct_medical_md_ms_doctor_pt',  'Medical', 'MD_MS_DOCTOR_PT',  '2026-11', 2, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  ('jct_medical_md_ms_faculty_ft', 'Medical', 'MD_MS_FACULTY_FT', '2026-11', 1, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  ('jct_medical_md_ms_faculty_pt', 'Medical', 'MD_MS_FACULTY_PT', '2026-11', 4, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  ('jct_medical_mbbs_doctor_ft',   'Medical', 'MBBS_DOCTOR_FT',   '2026-11', 3, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  ('jct_medical_staff_nurse',      'Medical', 'STAFF_NURSE',      '2026-11', 4, NULL, 'Monthly count given by the founder, 2026-11-14', NULL, 'Founder (monthly count)', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
