-- The WhatsApp number a template sends from (WaNumber.id); null = resolve as usual.
ALTER TABLE "MessageTemplate" ADD COLUMN "waNumberId" TEXT;
ALTER TABLE "MessageTemplateVersion" ADD COLUMN "waNumberId" TEXT;
