-- How a candidate SMS / WhatsApp is sent (2026-11-10): the Meta-approved WhatsApp template or the DLT template and the values for its blanks,
-- written when the message is recorded, read by utils/mailWorker.js. Additive only; a row without it is sent as before (the "bulk" template).
ALTER TABLE "CandidateMessage" ADD COLUMN "sendSpec" TEXT;
