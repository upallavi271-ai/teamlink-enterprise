// ---------------------------------------------------------------------------
// ASSET REPAIR HISTORY - export and IMPORT (utils/moduleIo.js contract).
// HRMS spec 2026-10-09, point 6: "import the complete repair history per asset:
// dates, issue, vendor, cost, status; match to assets by asset code / serial;
// no duplicates on re-run".
//
// One row = one repair of one asset (an asset may have many rows: its whole
// history). A row finds its asset by ASSET CODE, else by SERIAL NUMBER; a row
// that finds none is refused and listed (no asset is invented).
//
// NO DUPLICATES: a repair is the same repair when it is for the same asset,
// reported on the same day, for the same issue (or when its fingerprint -
// asset, dates, issue, vendor, cost - was imported before). The same file can
// be loaded again and nothing is added; an existing repair is never changed.
//
// An import records HISTORY only: it does not change the asset's status or
// holder, posts nothing to Accounts (a Completed repair with a cost shows in
// Accounts -> Asset postings as "Not posted", where Accounts decides), sends
// no notification and writes an audit row per repair.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const io = require('../utils/moduleIo');

const TYPES = ['Repair', 'Service', 'AMC', 'Replacement of part'];
const STATUSES = ['Reported', 'In Repair', 'Completed', 'Cancelled'];
const YES = /^(1|true|yes|y)$/i;

const columns = [
  { key: 'assetCode', label: 'Asset Code', example: 'AST-0101', note: 'The asset\'s code. Give this or the Serial Number.' },
  { key: 'serialNumber', label: 'Serial Number', example: 'SN12345', note: 'Used when the Asset Code is blank.' },
  { key: 'assetName', label: 'Asset Name', readOnly: true, example: 'Dell Latitude 5440' },
  { key: 'repairNo', label: 'Repair No', readOnly: true, example: '' },
  { key: 'dateReported', label: 'Date Reported', type: 'date', example: '2026-03-12', note: '2026-03-12, 12-03-2026 or 12-MAR-2026.' },
  { key: 'issue', label: 'Issue', required: true, example: 'Screen flickering' },
  { key: 'repairType', label: 'Repair Type', list: 'Repair Type', example: 'Repair', note: 'Blank = Repair.' },
  { key: 'vendor', label: 'Vendor', example: 'ABC Service Centre' },
  { key: 'repairDate', label: 'Repair Date', type: 'date', example: '2026-03-20', note: 'The day it came back / was fixed.' },
  { key: 'cost', label: 'Cost', type: 'number', example: '2500', note: 'Rupees, before GST.' },
  { key: 'gstPaid', label: 'GST Paid', type: 'number', example: '450' },
  { key: 'invoiceNo', label: 'Invoice No', example: 'INV-221' },
  { key: 'status', label: 'Status', list: 'Status', example: 'Completed', note: 'Blank = Completed when there is a Repair Date, else Reported.' },
  { key: 'underWarranty', label: 'Under Warranty', example: 'No', note: 'Yes or No.' },
  { key: 'notes', label: 'Notes', example: '' },
];

const assetScopeWhere = (user) => require('../routes/assetInventory').assetWhere(user, {}); // eslint-disable-line global-require

const fingerprint = (assetId, x) => `import:${crypto.createHash('sha1').update([assetId, x.dateReported || '', io.str(x.issue).toLowerCase(), io.str(x.vendor).toLowerCase(), x.repairDate || '', x.cost == null ? '' : x.cost].join('|')).digest('hex').slice(0, 24)}`;

module.exports = {
  key: 'asset-repairs',
  label: 'Asset repair history',
  module: 'Employee Services',
  what: 'asset repair records',
  feature: 'Employee Services',
  importActions: ['edit'],
  sheet: 'Repairs',
  entity: 'AssetRepair',
  selfExport: false,
  columns,
  instructions: [
    'One row = one repair of one asset. An asset can have many rows - give its whole repair history.',
    'The asset is found by Asset Code, or by Serial Number when the code is blank. A row whose asset is not found is listed and skipped.',
    'The same repair (same asset, reported day and issue) is never added twice, so the file can be loaded again safely. Existing repairs are not changed.',
    'The import records history only: the asset\'s status and holder do not change, and nothing is posted to Accounts.',
  ],
  lists: async () => ({ 'Repair Type': TYPES, Status: STATUSES }),

  async exportRows(ctx) {
    const assets = await prisma.asset.findMany({ where: assetScopeWhere(ctx.user), select: { id: true, assetCode: true, name: true, serialNumber: true } });
    const byId = new Map(assets.map((a) => [a.id, a]));
    const reps = await prisma.assetRepair.findMany({ where: { assetId: { in: [...byId.keys()] } }, orderBy: [{ dateReported: 'desc' }, { createdAt: 'desc' }] });
    return reps.map((r) => {
      const a = byId.get(r.assetId) || {};
      return {
        assetCode: a.assetCode || '', serialNumber: a.serialNumber || '', assetName: a.name || '', repairNo: r.repairNo,
        dateReported: r.dateReported || '', issue: r.issue || '', repairType: r.repairType || '', vendor: r.vendor || '', repairDate: r.repairDate || '',
        cost: r.cost, gstPaid: r.gstPaid, invoiceNo: r.invoiceNo || '', status: r.status, underWarranty: r.underWarranty ? 'Yes' : 'No', notes: r.notes || '',
      };
    });
  },

  async validate(rows, ctx) {
    const assets = await prisma.asset.findMany({ where: assetScopeWhere(ctx.user), select: { id: true, assetCode: true, name: true, serialNumber: true } });
    const byCode = new Map(assets.map((a) => [io.str(a.assetCode).toUpperCase(), a]));
    const bySerial = new Map(assets.filter((a) => a.serialNumber).map((a) => [io.str(a.serialNumber).toUpperCase(), a]));
    const found = rows.map((r) => {
      const code = io.str(r.assetCode).toUpperCase();
      const sn = io.str(r.serialNumber).toUpperCase();
      return (code && byCode.get(code)) || (!code && sn && bySerial.get(sn)) || null;
    });
    const ids = [...new Set(found.filter(Boolean).map((a) => a.id))];
    const existing = ids.length ? await prisma.assetRepair.findMany({ where: { assetId: { in: ids } } }) : [];
    const seen = new Set();
    return rows.map((r, i) => {
      const errors = io.requiredErrors(module.exports, r);
      const a = found[i];
      const code = io.str(r.assetCode);
      const sn = io.str(r.serialNumber);
      if (!code && !sn) errors.push({ field: 'Asset Code', message: 'Give the Asset Code (or the Serial Number).' });
      else if (!a) errors.push({ field: 'Asset Code', message: `No asset with ${code ? `code "${code}"` : `serial number "${sn}"`} in your scope - nothing was created for it.` });
      else if (code && sn && a.serialNumber && io.str(a.serialNumber).toUpperCase() !== sn.toUpperCase()) errors.push({ field: 'Serial Number', message: `The asset ${a.assetCode} has serial number ${a.serialNumber}, not ${sn}.` });
      const rep = io.parseDate(r.dateReported);
      const done = io.parseDate(r.repairDate);
      if (rep.error) errors.push({ field: 'Date Reported', message: `"${r.dateReported}" is not a date.` });
      if (done.error) errors.push({ field: 'Repair Date', message: `"${r.repairDate}" is not a date.` });
      if (rep.value && done.value && done.value < rep.value) errors.push({ field: 'Repair Date', message: 'The Repair Date is before the Date Reported.' });
      const type = io.str(r.repairType) ? io.pick(TYPES, r.repairType) : 'Repair';
      if (io.str(r.repairType) && !type) errors.push({ field: 'Repair Type', message: `"${r.repairType}" is not one of ${TYPES.join(', ')}.` });
      const stIn = io.str(r.status) ? io.pick(STATUSES, r.status) : null;
      if (io.str(r.status) && !stIn) errors.push({ field: 'Status', message: `"${r.status}" is not one of ${STATUSES.join(', ')}.` });
      const cost = io.parseNumber(r.cost);
      const gst = io.parseNumber(r.gstPaid);
      if (cost.error || (cost.value !== undefined && cost.value < 0)) errors.push({ field: 'Cost', message: `"${r.cost}" is not an amount.` });
      if (gst.error || (gst.value !== undefined && gst.value < 0)) errors.push({ field: 'GST Paid', message: `"${r.gstPaid}" is not an amount.` });
      const issue = io.str(r.issue).slice(0, 500);
      const label = a ? `${a.assetCode} · ${a.name}` : (code || sn);
      if (errors.length) return { line: r.line, label, errors, action: 'error' };
      const data = {
        assetId: a.id, dateReported: rep.value || null, issue, repairType: type, vendor: io.str(r.vendor).slice(0, 120) || null, repairDate: done.value || null,
        cost: cost.value || 0, gstPaid: gst.value || 0, invoiceNo: io.str(r.invoiceNo).slice(0, 80) || null,
        status: stIn || (done.value ? 'Completed' : 'Reported'), underWarranty: YES.test(io.str(r.underWarranty)), notes: io.str(r.notes).slice(0, 1000) || null,
      };
      const fp = fingerprint(a.id, { ...data, cost: cost.value });
      const dup = existing.find((x) => x.legacyEntryId === fp || (x.assetId === a.id && (x.dateReported || '') === (data.dateReported || '') && io.str(x.issue).toLowerCase() === issue.toLowerCase()));
      const key = `${fp}`;
      if (dup || seen.has(key)) return { line: r.line, label, errors: [], action: 'nochange', changes: [], notes: [dup ? `Already recorded${dup.repairNo ? ` (${dup.repairNo})` : ''} - not added again.` : `Same repair as an earlier row of this file - added once.`] };
      seen.add(key);
      return {
        line: r.line, label, errors: [], action: 'create',
        changes: [{ field: 'Repair', from: '', to: `${data.dateReported || 'no date'} · ${issue}${data.vendor ? ` · ${data.vendor}` : ''}${data.cost ? ` · ₹${data.cost}` : ''} · ${data.status}` }],
        data: { ...data, legacyEntryId: fp },
      };
    });
  },

  async apply(valid, ctx) {
    let created = 0;
    const failed = [];
    const actor = ctx.user.name || ctx.user.email;
    const batch = `RH-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    // eslint-disable-next-line no-restricted-syntax
    for (const v of valid) {
      try {
        const x = v.data;
        let row = null;
        for (let i = 0; i < 6 && !row; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const last = await prisma.assetRepair.findMany({ select: { repairNo: true }, orderBy: { repairNo: 'desc' }, take: 1 });
          const n = (last.length ? Number(String(last[0].repairNo).replace(/\D/g, '')) || 0 : 0) + 1 + i;
          try {
            // eslint-disable-next-line no-await-in-loop
            row = await prisma.assetRepair.create({ data: { repairNo: `RP-${String(n).padStart(5, '0')}`, reportedByName: `Imported history (${batch})`, ...x } });
          } catch (err) {
            if (!(err && err.code === 'P2002' && String(err.meta && err.meta.target).includes('repairNo'))) throw err;
          }
        }
        if (!row) throw new Error('Could not number the repair');
        // eslint-disable-next-line no-await-in-loop
        await prisma.auditLog.create({
          data: {
            userId: ctx.user.id, actorName: actor, action: 'Asset repair imported', entity: 'AssetRepair', entityId: row.id,
            toValue: `${row.repairNo} · ${x.issue} · ${x.status}`, reason: `${v.label} · batch ${batch}`,
          },
        });
        created += 1;
      } catch (err) {
        failed.push({ line: v.line, reason: String(err.message || err).split('\n').pop().slice(0, 200) });
      }
    }
    return { created, updated: 0, skipped: 0, failed, batch };
  },
};
