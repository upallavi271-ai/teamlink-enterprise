// ---------------------------------------------------------------------------
// VENDORS MAY EDIT AND IMPORT BILLS (founder 2026-10-28: "switch on the editing and importing the bills for vendors").
//
// New logins get it from the defaults (config/vendorModules.js: Assets "Allow editing" is now on by default). This
// switches it on ONCE for the logins that already exist, on the first start after this change:
//   * VendorUser.canEdit = true                     (Assets portal: edit asset details, upload / import repair bills)
//   * VendorLoginModule ticks set to true:          invoices.raise, airtel_bills.sendBill, monthly_bills.upload,
//                                                   office.uploadReceipts, id_card_orders.uploadProof
// Nothing else changes (purchase value, amounts, downloads stay as the admin set them). An admin can still switch any
// single login back to view only on Vendor Logins; this never runs again (AppSetting DONE_KEY), so that choice stands.
// One audit line says how many logins were switched on.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');

const DONE_KEY = 'vendor.switchOn.editAndBills.2026-10-28';
const BILL_TICKS = { invoices: 'raise', airtel_bills: 'sendBill', monthly_bills: 'upload', office: 'uploadReceipts', id_card_orders: 'uploadProof' };

const parse = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

async function run() {
  if (await prisma.appSetting.findUnique({ where: { key: DONE_KEY } })) return { skipped: true };
  const edit = await prisma.vendorUser.updateMany({ where: { canEdit: false }, data: { canEdit: true } });
  let ticks = 0;
  if (await DB.ready()) {
    const rows = await DB.q('SELECT "vendorUserId", "moduleKey", "permissionsJson" FROM "VendorLoginModule"');
    for (const r of rows) {
      const key = BILL_TICKS[r.moduleKey];
      if (!key) continue; // eslint-disable-line no-continue
      const p = parse(r.permissionsJson);
      if (p[key] === true) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await DB.run('UPDATE "VendorLoginModule" SET "permissionsJson" = ? WHERE "vendorUserId" = ? AND "moduleKey" = ?', [JSON.stringify({ ...p, [key]: true }), r.vendorUserId, r.moduleKey]);
      ticks += 1;
    }
  }
  await prisma.appSetting.create({ data: { key: DONE_KEY, value: JSON.stringify({ at: new Date().toISOString(), editOn: edit.count, billTicksOn: ticks }) } });
  await require('./audit').logAudit({ // eslint-disable-line global-require
    action: 'Vendor logins: editing and bill import switched on', entity: 'VendorUser',
    toValue: `${edit.count} login(s) may now edit; ${ticks} bill / upload tick(s) switched on`,
  });
  return { editOn: edit.count, billTicksOn: ticks };
}

// Never stops the server: a failure is logged and retried on the next start.
async function runSafe() {
  try {
    const r = await run();
    if (!r.skipped) console.log(`[vendors] editing + bill import switched on: ${r.editOn} login(s), ${r.billTicksOn} tick(s)`);
    return r;
  } catch (err) {
    console.error('[vendors] switch-on failed:', err && err.message);
    return { error: true };
  }
}

module.exports = { run, runSafe, DONE_KEY, BILL_TICKS };
