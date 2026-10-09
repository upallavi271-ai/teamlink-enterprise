-- Single sign-on to the Job Portal (2026-10-09): one row per sign-in, so a
-- session can be signed out on the server and time out after inactivity.
-- CREATE only - no existing table is touched.
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedReason" TEXT
);
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
