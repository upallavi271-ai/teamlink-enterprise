#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AUTOMATIC ASSET DETECTION FROM IMPORTED BILLS (founder 2026-10-28). SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node scripts/bill-asset-detect-test.js
// Proves:
//   D1 the AI answer keeps item name, brand, model and serial number of every line (validate.js)
//   D2 a one-asset bill: the serial read on the line finds the asset; its CURRENT holder (name + employee ID) is shown; Matched
//   D3 a multi-asset bill: two lines -> two different assets, each with its own holder (one assigned, one unassigned = in stock)
//   D4 two assets of the same brand + model: Needs review, nothing guessed; a line with only a name: Unmatched (never by name alone)
//   D5 Accounts links a line by hand: Linked by hand, who did it, history + audit; "new asset": pending verification with no asset;
//      clear: back to the automatic reading; a recruiter cannot do it (403)
//   D6 an edit that keeps a line's text keeps its link
//   D7 the Accounts list and the vendor's My Bills list carry the items (asset name, asset, holder, match status)
//   D8 nothing on any asset changed (assignment, status, history)
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('BAD');

(async () => {
  const { prisma } = Z;
  const made = { vendors: [], assets: [], uploads: [] };
  try {
    const V = require('../src/utils/billOcr/validate'); // eslint-disable-line global-require
    const BU = require('../src/utils/billUploads'); // eslint-disable-line global-require
    const DB = require('../src/utils/vmDb'); // eslint-disable-line global-require
    await BU.ensure();
    await require('../src/utils/assetVendorSchema').ensure(); // eslint-disable-line global-require

    // D1 - the reading keeps the new fields
    const n = V.normaliseModelOutput({ lines: [{ description: 'Dell Latitude 5420 laptop SN ABC12345 screen', item_name: 'Laptop', brand: 'Dell', model: 'Latitude 5420', serial_number: 'ABC12345', quantity: 1, rate: 2500, amount: 2500, confidence: 0.9, unclear: false, note: null }] });
    Z.check('D1 the AI answer keeps item name, brand, model and serial number of a line', n.lines.length === 1 && n.lines[0].itemName === 'Laptop' && n.lines[0].brand === 'Dell' && n.lines[0].model === 'Latitude 5420' && n.lines[0].serialNo === 'ABC12345', n.lines);

    const admin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' }, {});
    const rec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', accountsAccess: false, accountsRole: 'NONE' }, {});
    const T = await Z.mint(admin); const TR = await Z.mint(rec);
    const emp = await prisma.employee.findFirst({ where: { employmentStatus: 'Active', employeeCode: { not: '' } }, orderBy: { createdAt: 'asc' } });
    const R = Z.RUN.toUpperCase();
    const ven = await prisma.officeVendor.create({ data: { name: `ZZTEST BAD Vendor ${Z.RUN}`, companyName: 'ZZTEST BAD', isActive: true, category: 'Other' } });
    made.vendors.push(ven.id);
    const mkA = async (k, data) => { const a = await prisma.asset.create({ data: { assetCode: `ZZBAD-${R}-${k}`, history: '[]', vendorId: ven.id, ...data } }); made.assets.push(a.id); return a; };
    const lap = await mkA('1', { name: 'ZZ Laptop', category: 'Laptop', assetType: 'DELL LATITUDE 5420', serialNumber: `ZZSN${R}A1`, status: 'Assigned', assignedToId: emp.id, assignedAt: new Date('2026-10-01T05:00:00Z') });
    const mon = await mkA('2', { name: 'ZZ Monitor', category: 'Monitor', assetType: `HP P24V ZZ${R}`, serialNumber: `ZZSN${R}M2`, status: 'Available' });
    await mkA('3', { name: 'ZZ Mouse a', category: 'Mouse', assetType: `ZZLOGI M${R}90`, status: 'Available' });
    await mkA('4', { name: 'ZZ Mouse b', category: 'Mouse', assetType: `ZZLOGI M${R}90`, status: 'Available' });
    const assetsBefore = JSON.stringify(await prisma.asset.findMany({ where: { id: { in: made.assets } }, orderBy: { id: 'asc' }, select: { id: true, status: true, assignedToId: true, assignedAt: true, history: true, serialNumber: true } }));

    // a bill as the reading leaves it: 4 lines (serial; brand+model; same model twice; name only)
    const now = new Date().toISOString();
    const up = { id: `buzz${Z.RUN}`, code: `BU-ZZ${R}` };
    await DB.run('INSERT INTO "VendorBillUpload" ("id","code","vendorId","status","uploadedAt","createdAt","updatedAt","invoiceNo","invoiceDate","total","fileCount","filesJson") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [up.id, up.code, ven.id, 'NEEDS_REVIEW', now, now, now, `ZZBADINV${R}`, '2026-10-15', 9000, 0, '[]']);
    made.uploads.push(up.id);
    const lines = [
      [1, `Laptop screen replaced`, 'Laptop', 'Dell', 'Latitude 5420', `ZZSN${R}A1`, 1, 6000],
      [2, `HP P24V ZZ${R} monitor panel`, 'Monitor', 'HP', `P24V ZZ${R}`, null, 1, 2500],
      [3, `ZZLOGI M${R}90 mouse`, 'Mouse', 'ZZLOGI', `M${R}90`, null, 1, 300],
      [4, 'Keyboard', 'Keyboard', null, null, null, 1, 200],
    ];
    for (const [no, d, item, b, m, sn, q, amt] of lines) {
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT INTO "VendorBillUploadLine" ("id","uploadId","lineNo","description","quantity","rate","amount","confidence","unclear","note","edited","createdAt","itemName","brand","model","serialNo") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [`blzz${Z.RUN}${no}`, up.id, no, d, q, amt, amt, 0.9, 0, null, 0, now, item, b, m, sn]);
    }

    const det = async () => (await Z.call('GET', `/api/vendor-bills/uploads/${up.id}`, T)).body.upload;
    let d = await det();
    const L = (k) => (d.lineAssets || []).find((x) => x.lineNo === k) || {};
    Z.check('D2 the serial read on line 1 finds the laptop; its current holder (name + employee ID) is shown; Matched', L(1).asset && L(1).asset.id === lap.id && L(1).how === 'Serial number on the bill' && L(1).now && L(1).now.name === emp.name && L(1).now.employeeCode === emp.employeeCode && L(1).matchStatus === 'Matched' && L(1).itemName === 'Laptop', L(1));
    Z.check('D3 two lines -> two different assets: the monitor by brand + model, in stock (no holder)', L(2).asset && L(2).asset.id === mon.id && L(2).now === null && L(2).matchStatus === 'Matched' && L(2).asset.status === 'Available', L(2));
    Z.check('D4 same brand + model on two assets: Needs review, nothing guessed; a name only (Keyboard): Unmatched', !L(3).asset && L(3).matchStatus === 'Needs review' && !L(4).asset && L(4).matchStatus === 'Unmatched', [L(3), L(4)]);
    Z.check('D4b the detail offers the vendor\'s assets to link to (with who holds each)', (d.assetOptions || []).some((a) => a.id === lap.id && a.holder === emp.name) && (d.assetOptions || []).some((a) => a.id === mon.id && a.holder === null), (d.assetOptions || []).length);

    // D5 - by hand
    const no = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, TR, { lineNo: 3, kind: 'linked', assetId: mon.id });
    const r1 = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, T, { lineNo: 3, kind: 'linked', assetId: made.assets[2] });
    d = r1.body.upload || {};
    Z.check('D5 a recruiter cannot link (403); Accounts links line 3 by hand: Linked by hand, by whom', no.status === 403 && r1.status === 200 && L(3).asset && L(3).asset.id === made.assets[2] && L(3).matchStatus === 'Linked by hand' && L(3).linkedBy && L(3).linkedBy.name, [no.status, r1.status, L(3)]);
    const r2 = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, T, { lineNo: 4, kind: 'new' });
    d = r2.body.upload || {};
    Z.check('D5b line 4 marked a new asset: "New asset - pending verification", no asset created or chosen', r2.status === 200 && !L(4).asset && L(4).matchStatus === 'New asset - pending verification' && (await prisma.asset.count({ where: { vendorId: ven.id } })) === 4, L(4));
    const hist = (d.history || []).filter((h) => h.field === 'line asset');
    const aud = await prisma.auditLog.count({ where: { entityId: up.id, action: 'Vendor bill line asset set' } });
    Z.check('D5c each change is in the bill history (old -> new) and the audit log', hist.length === 2 && aud === 2 && hist.some((h) => /New asset/.test(h.to)), [hist.length, aud]);
    const bad = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, T, { lineNo: 3, kind: 'linked', assetId: 'zz-no-such-asset' });
    const noLine = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, T, { lineNo: 99, kind: 'new' });
    Z.check('D5d an unknown asset or line is refused, nothing saved', bad.status === 400 && noLine.status === 404, [bad.status, noLine.status]);

    // D6 - an edit that keeps line 3's text keeps its link (line 2 changes text)
    const cur = await det();
    const body = { lines: cur.lines.map((l) => ({ description: l.lineNo === 2 ? 'Monitor panel (corrected)' : l.description, quantity: l.quantity, rate: l.rate, amount: l.amount })), updatedAt: cur.updatedAt };
    const ed = await Z.call('PATCH', `/api/vendor-bills/uploads/${up.id}`, T, body);
    d = await det();
    Z.check('D6 after an edit, line 3 (same text) keeps its hand link and line 1 keeps the serial read on it', ed.status === 200 && L(3).matchStatus === 'Linked by hand' && L(1).serialNo === `ZZSN${R}A1` && L(1).asset && L(1).asset.id === lap.id, [ed.status, ed.body && ed.body.error, L(3).matchStatus, L(1).serialNo]);
    const r3 = await Z.call('POST', `/api/vendor-bills/uploads/${up.id}/line-asset`, T, { lineNo: 3, kind: 'clear' });
    d = r3.body.upload || {};
    Z.check('D5e clear: line 3 is back to the automatic reading (Needs review again)', r3.status === 200 && L(3).matchStatus === 'Needs review' && !L(3).linkedBy, L(3));

    // D7 - the lists
    const list = await Z.call('GET', `/api/vendor-bills/uploads?q=${encodeURIComponent(up.code)}`, T);
    const row = (list.body.rows || []).find((x) => x.id === up.id);
    Z.check('D7 the Accounts list row carries the items: count, the laptop with its holder, match statuses', !!row && row.items && row.items.count === 4 && row.items.items[0].itemName === 'Laptop' && row.items.items[0].holder === emp.name && row.items.items[0].matchStatus === 'Matched' && row.items.needsReview >= 1, row && row.items);
    const vl = await BU.listForVendor({ vendorId: ven.id, canEdit: true }, {});
    const vrow = (vl.rows || []).find((x) => x.id === up.id);
    Z.check('D7b the vendor\'s My Bills list row carries the same items', !!vrow && vrow.items && vrow.items.count === 4 && vrow.items.items[0].holder === emp.name, vrow && vrow.items);

    const assetsAfter = JSON.stringify(await prisma.asset.findMany({ where: { id: { in: made.assets } }, orderBy: { id: 'asc' }, select: { id: true, status: true, assignedToId: true, assignedAt: true, history: true, serialNumber: true } }));
    Z.check('D8 nothing on any asset changed (assignment, status, history, serial)', assetsBefore === assetsAfter);
  } catch (err) { Z.fail += 1; console.log('FAIL  crashed', err && err.stack ? err.stack.slice(0, 900) : err); } finally {
    try {
      const DB = require('../src/utils/vmDb'); // eslint-disable-line global-require
      for (const id of made.uploads) {
        // eslint-disable-next-line no-await-in-loop
        for (const sql of ['DELETE FROM "VendorBillLineAsset" WHERE "uploadId" = ?', 'DELETE FROM "VendorBillUploadLine" WHERE "uploadId" = ?', 'DELETE FROM "VendorBillUpload" WHERE "id" = ?']) await DB.run(sql, [id]).catch(() => {});
      }
      await prisma.auditLog.deleteMany({ where: { entityId: { in: [...made.uploads, ...made.assets, ...made.vendors] } } });
      await prisma.asset.deleteMany({ where: { id: { in: made.assets } } });
      await prisma.officeVendor.deleteMany({ where: { id: { in: made.vendors } } });
    } catch (e) { console.log('cleanup failed:', String(e.message).slice(-200)); }
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
