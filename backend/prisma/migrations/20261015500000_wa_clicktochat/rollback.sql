-- Undo 20261015500000_wa_clicktochat (drops the four WhatsApp quick-chat tables and their data).
DROP TABLE IF EXISTS "WaBulkSession";
DROP TABLE IF EXISTS "WaOptIn";
DROP TABLE IF EXISTS "WaLog";
DROP TABLE IF EXISTS "WaTemplate";
