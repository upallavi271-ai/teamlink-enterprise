-- Rollback of 20261017120000_omni_gs_crm. Only the extra index is removed here; OmniForm / OmniFormSubmission belong to 20261017100000_omni_v3_library_forms
-- (roll that one back to drop them). The nullable OmniForm columns (description, memberIds) are harmless and left alone (SQLite cannot drop them safely).
-- The AppSetting rows omni.customFields and omni.segmentCounts may stay: nothing else reads them.
DROP INDEX IF EXISTS "OmniFormSubmission_contact";
