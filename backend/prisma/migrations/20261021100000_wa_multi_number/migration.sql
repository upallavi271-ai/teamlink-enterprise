-- MANY WHATSAPP NUMBERS (2026-10-21). Additive only: four new tables, nothing existing is altered.
--   WaNumber        one row per WhatsApp business number (label, display number, Meta Phone number ID, WABA id, default flag, status cache).
--                   Tokens / app secrets are NOT here: they are encrypted in AppSetting 'wa.num.sec.<id>' (utils/secrets.js).
--   WaNumberAccess  who may send from a number: a department, a person or a role (UNIQUE per number + kind + ref).
--   WaThread        one chat per (number, contact phone): the number a conversation runs on, last inbound / outbound, the 24-hour session.
--   WaMessageMap    provider message id -> the number it used (delivery reports and the Inbox find the number by it).
-- The same statements run by themselves (CREATE ... IF NOT EXISTS) the first time an Admin adds a number (utils/waNumbers.js ensure()),
-- so "prisma migrate deploy" afterwards is a no-op. With no row in WaNumber the old single WhatsApp connection works exactly as before.

CREATE TABLE IF NOT EXISTS "WaNumber" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "displayDigits" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "credSource" TEXT NOT NULL DEFAULT 'own',
    "tokenMode" TEXT NOT NULL DEFAULT 'own',
    "language" TEXT,
    "tplLink" TEXT,
    "tplOtp" TEXT,
    "tplBulk" TEXT,
    "active" INTEGER NOT NULL DEFAULT 1,
    "isDefault" INTEGER NOT NULL DEFAULT 0,
    "statusCode" TEXT NOT NULL DEFAULT 'unchecked',
    "statusText" TEXT,
    "checkedAt" TEXT,
    "qualityRating" TEXT,
    "verifiedName" TEXT,
    "webhookNote" TEXT,
    "removedAt" TEXT,
    "removedByName" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_phoneid" ON "WaNumber"("phoneNumberId") WHERE "removedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_digits" ON "WaNumber"("displayDigits") WHERE "removedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "WaNumber_one_default" ON "WaNumber"("isDefault") WHERE "isDefault" = 1 AND "removedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "WaNumberAccess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "numberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "refLabel" TEXT,
    "grantedById" TEXT,
    "grantedByName" TEXT,
    "grantedAt" TEXT NOT NULL
  );

CREATE UNIQUE INDEX IF NOT EXISTS "WaNumberAccess_one" ON "WaNumberAccess"("numberId", "kind", "refId");

CREATE INDEX IF NOT EXISTS "WaNumberAccess_ref" ON "WaNumberAccess"("kind", "refId");

CREATE TABLE IF NOT EXISTS "WaThread" (
    "numberId" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "personType" TEXT,
    "personId" TEXT,
    "personName" TEXT,
    "lastInboundAt" TEXT,
    "lastOutboundAt" TEXT,
    "lastMessageAt" TEXT NOT NULL,
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("numberId", "contact")
  );

CREATE INDEX IF NOT EXISTS "WaThread_contact" ON "WaThread"("contact", "lastMessageAt");

CREATE INDEX IF NOT EXISTS "WaThread_person" ON "WaThread"("personType", "personId");

CREATE TABLE IF NOT EXISTS "WaMessageMap" (
    "providerRef" TEXT NOT NULL PRIMARY KEY,
    "numberId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "contact" TEXT,
    "personType" TEXT,
    "personId" TEXT,
    "createdAt" TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS "WaMessageMap_number" ON "WaMessageMap"("numberId", "createdAt");

CREATE INDEX IF NOT EXISTS "WaMessageMap_person" ON "WaMessageMap"("personType", "personId");
