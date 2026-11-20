-- Manual browser calling: same statements as backend/src/browsercall/schema.js
CREATE TABLE IF NOT EXISTS "BrowserCallSetting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT, "updatedAt" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "BrowserCallExtension" (
    "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "extension" TEXT NOT NULL, "secretEnc" TEXT NOT NULL,
    "active" INTEGER NOT NULL DEFAULT 1, "rotatedAt" TEXT, "expiresAt" TEXT, "createdAt" TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallExtension_user" ON "BrowserCallExtension"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCallExtension_ext" ON "BrowserCallExtension"("extension");
CREATE TABLE IF NOT EXISTS "BrowserCall" (
    "id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL, "asteriskUniqueId" TEXT, "asteriskLinkedId" TEXT,
    "candidateId" TEXT NOT NULL, "applicationId" TEXT, "userId" TEXT NOT NULL, "userName" TEXT,
    "toNumber" TEXT NOT NULL, "extension" TEXT NOT NULL, "direction" TEXT NOT NULL DEFAULT 'outbound', "mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'initiated', "startAt" TEXT NOT NULL, "answerAt" TEXT, "endAt" TEXT,
    "durationSec" INTEGER, "talkSec" INTEGER, "hangupCause" INTEGER, "hangupReason" TEXT, "dialStatus" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCall_token" ON "BrowserCall"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "BrowserCall_uid" ON "BrowserCall"("asteriskUniqueId") WHERE "asteriskUniqueId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "BrowserCall_cand" ON "BrowserCall"("candidateId", "startAt");
CREATE INDEX IF NOT EXISTS "BrowserCall_user" ON "BrowserCall"("userId", "startAt");
CREATE TABLE IF NOT EXISTS "BrowserCallEvent" (
    "id" TEXT NOT NULL PRIMARY KEY, "callId" TEXT, "uniqueId" TEXT, "event" TEXT NOT NULL, "payload" TEXT, "at" TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS "BrowserCallEvent_call" ON "BrowserCallEvent"("callId", "at");
