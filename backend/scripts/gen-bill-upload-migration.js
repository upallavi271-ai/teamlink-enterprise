// Writes prisma/migrations/20261021120000_vendor_bill_upload/{migration,rollback}.sql from utils/billUploadSchema.js (one source of truth).
const fs = require('fs');
const path = require('path');
const { DDL } = require('../src/utils/billUploadSchema');

const dir = path.join(__dirname, '..', 'prisma', 'migrations', '20261021120000_vendor_bill_upload');
fs.mkdirSync(dir, { recursive: true });
const head = [
  '-- Vendor bill uploads with AI reading (2026-10-21): ADDITIVE ONLY. The same statements utils/billUploadSchema.js runs by itself the first time the feature needs them',
  '-- (CREATE ... IF NOT EXISTS, so applying this by hand and the runtime provisioning never conflict). Nothing existing is altered.',
  '-- The upload history is append-only at database level (same break-glass setting as the asset audit trail: AppSetting audit.allowPurge = 1).',
  '', '',
].join('\n');
fs.writeFileSync(path.join(dir, 'migration.sql'), `${head}${DDL.map((s) => `${s.replace(/^ {2}/gm, '').trim()};`).join('\n\n')}\n`);
fs.writeFileSync(path.join(dir, 'rollback.sql'), [
  '-- Rollback of 20261021120000_vendor_bill_upload. Deletes the uploaded-bill records, their table rows and their history.',
  '-- Bills that were already APPROVED into Accounts (VendorBillSubmission / OfficeExpense) and repair figures written into AssetRepair are NOT touched.',
  '-- The stored bill files stay in the upload folder.',
  'DROP TRIGGER IF EXISTS "VendorBillUploadEvent_append_only_upd";',
  'DROP TRIGGER IF EXISTS "VendorBillUploadEvent_append_only_del";',
  'DROP TABLE IF EXISTS "VendorBillUploadEvent";',
  'DROP TABLE IF EXISTS "VendorBillUploadLine";',
  'DROP TABLE IF EXISTS "VendorBillUpload";',
  '',
].join('\n'));
console.log('written', dir);
