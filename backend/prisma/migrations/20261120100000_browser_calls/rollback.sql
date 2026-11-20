-- Rollback of 20261120100000_browser_calls (all browser call rows, events, extensions and settings are DELETED)
DROP TABLE IF EXISTS "BrowserCallEvent";
DROP TABLE IF EXISTS "BrowserCall";
DROP TABLE IF EXISTS "BrowserCallExtension";
DROP TABLE IF EXISTS "BrowserCallSetting";
