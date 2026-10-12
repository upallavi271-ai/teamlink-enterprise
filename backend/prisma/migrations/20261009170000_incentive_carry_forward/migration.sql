-- HRMS spec 2026-10-09 point 4, user answers: the joinings target CARRIES FORWARD.
-- ADDITIVE ONLY (3 defaulted / nullable columns). Undo: rollback.sql.
--   IncentiveRule.carryForward   a month's missing joinings are added to the next month's target
--   IncentiveAward.baseTarget    the rule's base target that month (e.g. 4)
--   IncentiveAward.carriedIn     the part carried in from earlier months (e.g. 2)
ALTER TABLE "IncentiveRule" ADD COLUMN "carryForward" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IncentiveAward" ADD COLUMN "baseTarget" REAL;
ALTER TABLE "IncentiveAward" ADD COLUMN "carriedIn" REAL;
