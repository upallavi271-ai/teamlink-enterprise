-- eMudhra eSign (2026-10-05): the agreement LINK's own settings get their own
-- column, so Client.agreementEsignTxnId holds only the eSign provider's
-- transaction id. ADDITIVE ONLY: one nullable column.
-- Folder name: 20261005190000_agreement_link_meta
ALTER TABLE "Client" ADD COLUMN "agreementLinkMeta" TEXT;
-- Move the link settings written into agreementEsignTxnId so far ("LINK;d=14…").
UPDATE "Client" SET "agreementLinkMeta" = "agreementEsignTxnId", "agreementEsignTxnId" = NULL
  WHERE "agreementEsignTxnId" LIKE 'LINK;%';
