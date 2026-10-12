-- msgtpl_: Message templates (Email / SMS / WhatsApp) with versions.
-- TWO NEW TABLES ONLY. No existing table is touched.
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purpose" TEXT NOT NULL,
    "purposeLabel" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'candidate',
    "channel" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'English',
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "waTemplateName" TEXT,
    "waLanguageCode" TEXT,
    "waStatus" TEXT NOT NULL DEFAULT 'None',
    "waVars" TEXT,
    "dltTemplateId" TEXT,
    "senderId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "updatedById" TEXT,
    "updatedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "MessageTemplate_purpose_channel_language_idx" ON "MessageTemplate"("purpose", "channel", "language");

CREATE TABLE "MessageTemplateVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "waTemplateName" TEXT,
    "waStatus" TEXT,
    "waVars" TEXT,
    "dltTemplateId" TEXT,
    "senderId" TEXT,
    "changeNote" TEXT,
    "changedById" TEXT,
    "changedByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MessageTemplateVersion_templateId_idx" ON "MessageTemplateVersion"("templateId");
