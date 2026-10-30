-- RCS messaging (founder 2026-10-30, rcssms.in): templates, one log row per number, and the background send batches.
-- CreateTable
CREATE TABLE "rcs_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rcstype" TEXT NOT NULL,
    "body_json" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "module" TEXT,
    "created_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "rcs_message_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "entity_id" TEXT,
    "person_name" TEXT,
    "msisdn" TEXT NOT NULL,
    "templateid" TEXT NOT NULL,
    "rcstype" TEXT,
    "variables_json" TEXT,
    "msgid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error_code" TEXT,
    "error_text" TEXT,
    "request_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_by_id" TEXT,
    "sent_by_name" TEXT,
    "sent_at" DATETIME,
    "delivered_at" DATETIME,
    "fallback_status" TEXT,
    "fallback_ref" TEXT,
    "fallback_error" TEXT,
    "fallback_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "rcs_batches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "templateid" TEXT NOT NULL,
    "rcstype" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "total" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_try_at" DATETIME,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "rcs_templates_status_idx" ON "rcs_templates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rcs_templates_templateid_key" ON "rcs_templates"("templateid");

-- CreateIndex
CREATE INDEX "rcs_message_logs_msgid_idx" ON "rcs_message_logs"("msgid");

-- CreateIndex
CREATE INDEX "rcs_message_logs_request_ref_status_idx" ON "rcs_message_logs"("request_ref", "status");

-- CreateIndex
CREATE INDEX "rcs_message_logs_status_sent_at_idx" ON "rcs_message_logs"("status", "sent_at");

-- CreateIndex
CREATE INDEX "rcs_message_logs_module_created_at_idx" ON "rcs_message_logs"("module", "created_at");

-- CreateIndex
CREATE INDEX "rcs_message_logs_msisdn_idx" ON "rcs_message_logs"("msisdn");

-- CreateIndex
CREATE INDEX "rcs_batches_status_idx" ON "rcs_batches"("status");

