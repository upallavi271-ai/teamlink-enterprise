-- Rollback of 20261021100000_wa_multi_number.
-- The list of numbers, their assignments, the per-number chats and the message-to-number map are deleted. The old single WhatsApp connection
-- (Integration 'whatsapp') is untouched and keeps working. Per-number tokens / secrets (AppSetting 'wa.num.sec.*') and the numbers' settings are removed too.
DROP TABLE IF EXISTS "WaMessageMap";
DROP TABLE IF EXISTS "WaThread";
DROP TABLE IF EXISTS "WaNumberAccess";
DROP TABLE IF EXISTS "WaNumber";
DELETE FROM "AppSetting" WHERE "key" LIKE 'wa.num.sec.%' OR "key" = 'wa.numbers.settings';
-- (Unknown-number events kept in OmniProviderEvent with provider whatsapp.unknown-number are harmless history; delete them by hand if you want: DELETE FROM "OmniProviderEvent" WHERE "provider" = 'whatsapp.unknown-number';)
