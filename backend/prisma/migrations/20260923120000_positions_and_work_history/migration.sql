-- positions_and_work_history
--
-- A POSITION IS A SEAT, AND IT OUTLIVES THE PERSON SITTING IN IT.
--
-- "medical lo recruiters vunnaru, vallu MED-1, MED-2 ilaa positions
--  pettukuntaru. MED-1 resign chesthe, MED-1 place loki inkoka person
--  vastharu — kaani intha varaku work chesina MED-1 history kanipinchali,
--  kotha vallu eppudu work chesthunnaro kuda kanipinchali."
--
-- The company already works this way: the source sheets are full of "MED -2",
-- "MED 4(Dilip)", "Non It-03" and "Renuka-Edu Bde 1". The seat is how the desk
-- is staffed and reported on; the person is who is in it this quarter.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON Employee. A column would say who
-- holds MED-1 today and nothing else. The question being asked is a HISTORY —
-- who held it, between which dates, and what was done while they did. That is
-- a row per tenure, which is what PositionAssignment is.
--
-- WHY THE CODE IS SNAPSHOTTED ONTO EACH WORK RECORD as well as the id. A
-- position can be renamed and an assignment can be corrected; a follow-up made
-- in March under "MED-1" must still say MED-1 afterwards. Same reason
-- ApplicationStageEvent already snapshots the requirement title and the client
-- name rather than only joining to them.

CREATE TABLE "Position" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "code"       TEXT NOT NULL,
  "name"       TEXT,
  "department" TEXT,
  "team"       TEXT,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "notes"      TEXT,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Position_code_key" ON "Position"("code");
CREATE INDEX "Position_department_idx" ON "Position"("department");

-- One row per TENURE. toDate null means "sitting in it now".
CREATE TABLE "PositionAssignment" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "positionId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "fromDate"   TEXT NOT NULL,
  "toDate"     TEXT,
  "note"       TEXT,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PositionAssignment_positionId_fkey" FOREIGN KEY ("positionId")
    REFERENCES "Position" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PositionAssignment_employeeId_fkey" FOREIGN KEY ("employeeId")
    REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PositionAssignment_positionId_idx" ON "PositionAssignment"("positionId");
CREATE INDEX "PositionAssignment_employeeId_idx" ON "PositionAssignment"("employeeId");

-- --- The seat stamped onto the work itself --------------------------------
-- Plain ADD COLUMNs, all nullable: everything already recorded stays valid and
-- simply has no seat against it.

-- Which seat owns this requirement.
ALTER TABLE "Requirement" ADD COLUMN "positionId" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "positionCode" TEXT;

-- Which seat moved this candidate, at the moment it was moved.
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "actorPositionId" TEXT;
ALTER TABLE "ApplicationStageEvent" ADD COLUMN "actorPositionCode" TEXT;

-- Which seat owns and which seat completed this follow-up.
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "ownerPositionId" TEXT;
ALTER TABLE "ApplicationFollowUp" ADD COLUMN "ownerPositionCode" TEXT;

CREATE INDEX "Requirement_positionId_idx" ON "Requirement"("positionId");
CREATE INDEX "ApplicationStageEvent_actorPositionId_idx" ON "ApplicationStageEvent"("actorPositionId");
CREATE INDEX "ApplicationFollowUp_ownerPositionId_idx" ON "ApplicationFollowUp"("ownerPositionId");
