-- Rollback of 20261017180000_omni_gs_console_inbox (the Communication Console send history is deleted; nothing else is touched)
DROP TABLE IF EXISTS "OmniSendUpload";
DROP TABLE IF EXISTS "OmniSendRunItem";
DROP TABLE IF EXISTS "OmniSendRun";
