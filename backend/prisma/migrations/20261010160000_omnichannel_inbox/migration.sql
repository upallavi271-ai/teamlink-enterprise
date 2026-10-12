-- Omnichannel (user, 2026-10-10): one conversation per person (Call / Mail / WhatsApp / SMS) and one Inbox.
-- ADDITIVE ONLY: two new tables, nothing existing is touched.
--   Conversation         one row per person: unread count, who deals with it, done/open, preferred channel,
--                        "waiting for a reply" reminder. (personType CANDIDATE | CLIENT | EMPLOYEE)
--   ConversationMessage  the messages of CLIENT and EMPLOYEE people (a candidate's messages stay in CandidateMessage,
--                        which already holds sent mail / WhatsApp / SMS / calls and WhatsApp replies).
-- The application reads and writes both tables with plain SQL, so it works before or after `prisma generate`.
-- Undo: rollback.sql.
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personType" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "personName" TEXT,
    "department" TEXT,
    "ownerUserId" TEXT,
    "ownerName" TEXT,
    "lastMessageAt" DATETIME,
    "lastChannel" TEXT,
    "lastDirection" TEXT,
    "lastSnippet" TEXT,
    "lastInboundAt" DATETIME,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "doneAt" DATETIME,
    "doneByName" TEXT,
    "preferredChannel" TEXT,
    "awaitUntil" DATETIME,
    "awaitChannel" TEXT,
    "awaitNext" TEXT,
    "awaitNotifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Conversation_personType_personId_key" ON "Conversation"("personType", "personId");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
CREATE INDEX "Conversation_ownerUserId_idx" ON "Conversation"("ownerUserId");

CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "personType" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUT',
    "subject" TEXT,
    "body" TEXT,
    "address" TEXT,
    "status" TEXT,
    "statusDetail" TEXT,
    "providerRef" TEXT,
    "mailMessageId" TEXT,
    "inReplyTo" TEXT,
    "templateLabel" TEXT,
    "senderUserId" TEXT,
    "senderName" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ConversationMessage_conversationId_createdAt_idx" ON "ConversationMessage"("conversationId", "createdAt");
CREATE INDEX "ConversationMessage_providerRef_idx" ON "ConversationMessage"("providerRef");
CREATE INDEX "ConversationMessage_mailMessageId_idx" ON "ConversationMessage"("mailMessageId");
