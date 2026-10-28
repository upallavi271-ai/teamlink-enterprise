// ---------------------------------------------------------------------------
// THE ID CARD VENDOR PORTAL - what an ID CARD VENDOR sees and may do (2026-10-19).
// Routes: routes/idCardVendorPortal.js. Pages: frontend/src/pages/vendor/IdCard*.jsx.
//
// WHAT EXISTS (nothing is copied or invented):
//   * The company (HR, Employee Management > ID card orders) places an ORDER with the vendor: IdCardOrder (one status for the whole
//     order: New > Received > Printing > Ready > Delivered) with one IdCardOrderLine per employee (a snapshot of the employee's ID,
//     name, designation, department, blood group and the id of the stored Photo document) and IdCardOrderEvent rows (history).
//   * A REQUEST in this portal = one line (one employee's card). It has the status of its order: the app keeps no status per card.
//   * The four modules are views of those lines by status (config/vendorModules.js IDCARD_BUCKETS, disjoint, they add up to "all"):
//       Pending = New, Received, Printing    Completed = Ready (printing finished, waiting to be handed over)    Delivered = Delivered
//     Printing status and delivery status are DERIVED from the one real status (Printing: Not started / Printing / Printed;
//     Delivery: Not yet / Ready to deliver / Delivered). No deadline rule exists in the app, so there is no "overdue": only "waiting since".
//   * There is NO ID-card template / generator / QR in the app (the vendor receives the data + photos and prints on its own system),
//     so there is no "View ID Card" preview: the portal offers the data, the photo and a print-friendly list instead.
//
// SECURITY: the vendor id is the SESSION's. Every query joins IdCardOrder and filters o."vendorId" = <session vendor>; a line id,
// order id or notice id from the browser only ever selects a row INSIDE that set (someone else's = the same 403 as a missing one).
// Responses carry only ID-card fields (no salary, payroll, ATS or financial data - the lines never held any).
// An action changes ONE thing: the order's status, one step forward (same as the old screen). Nothing completes or delivers by itself.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./vmDb');
const SCH = require('./idCardVendorSchema');
const VP = require('./vendorPortal');
const VM = require('./vendorModules');
const CFG = require('../config/vendorModules');
const attachments = require('./attachments');

const { str } = VP;
const FLOW = CFG.IDCARD_FLOW;
const STAMP = { Received: 'receivedAt', Printing: 'printingAt', Ready: 'readyAt', Delivered: 'deliveredAt' };
const NOT_YOURS = { error: 'Forbidden. This is not yours.' };
const NEXT_BUTTON = { Received: 'Mark as Received', Printing: 'Start Printing', Ready: 'Mark as Ready', Delivered: 'Mark as Delivered' };
const IST = '+05:30';
const dayStart = (d) => new Date(`${d}T00:00:00${IST}`).getTime();
const nextOf = (status) => FLOW[FLOW.indexOf(status) + 1] || null;
const tms = (v) => { const d = DB.toDate(v); return d ? d.toISOString() : null; };

// What this login may do (the old module ticks; a login without module rows = the defaults, all on).
async function permsOf(row) {
  const eff = await VM.effectiveModules(row);
  const m = eff.map.get('id_card_orders');
  const saved = m ? m.permissions : {};
  const ok = (k) => CFG.permAllowed('id_card_orders', saved, k);
  return { updateStatus: ok('updateStatus'), download: ok('download'), uploadProof: ok('uploadProof') };
}

// ---- the request rows ----------------------------------------------------------------------------
const FROM = 'FROM "IdCardOrderLine" l JOIN "IdCardOrder" o ON o."id" = l."orderId"';
const statusesFor = (map, value) => FLOW.filter((s) => map[s] === value);
// where + params from the query; `skip` leaves one filter out (cascading facet counts).
function where(v, q, skip) {
  const w = ['o."vendorId" = ?']; const p = [v.vendorId];
  const bucket = CFG.IDCARD_BUCKETS[str(q.bucket)] || CFG.IDCARD_BUCKETS.all;
  w.push(`o."status" IN (${bucket.map(() => '?').join(',')})`); p.push(...bucket);
  if (skip !== 'department' && str(q.department)) { w.push('l."department" = ?'); p.push(str(q.department)); }
  if (skip !== 'status' && str(q.status)) { w.push('o."status" = ?'); p.push(str(q.status)); }
  if (skip !== 'printing' && str(q.printing)) { const s = statusesFor(CFG.IDCARD_PRINTING, str(q.printing)); w.push(`o."status" IN (${(s.length ? s : ['-']).map(() => '?').join(',')})`); p.push(...(s.length ? s : ['-'])); }
  if (skip !== 'delivery' && str(q.delivery)) { const s = statusesFor(CFG.IDCARD_DELIVERY, str(q.delivery)); w.push(`o."status" IN (${(s.length ? s : ['-']).map(() => '?').join(',')})`); p.push(...(s.length ? s : ['-'])); }
  if (VP.YMD.test(str(q.from))) { w.push('l."createdAt" >= ?'); p.push(dayStart(str(q.from))); }
  if (VP.YMD.test(str(q.to))) { w.push('l."createdAt" < ?'); p.push(dayStart(str(q.to)) + 86400000); }
  const s = VP.cleanText(q.q, 80).toLowerCase();
  if (s) {
    w.push('(' + ['l."employeeCode"', 'l."employeeName"', 'l."department"', 'l."designation"', 'o."orderCode"'].map((c) => `lower(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
    const like = `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    p.push(like, like, like, like, like);
  }
  return { sql: w.join(' AND '), params: p };
}
const SORTS = {
  employeeCode: 'l."employeeCode"', employeeName: 'l."employeeName"', department: 'l."department"', designation: 'l."designation"',
  requestDate: 'l."createdAt"', orderCode: 'o."orderCode"', status: `CASE o."status" ${FLOW.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 9 END`,
};
const row = (l, canPhoto) => ({
  id: l.id, orderId: l.orderId, requestRef: l.orderCode, employeeCode: l.employeeCode || null, name: l.employeeName, department: l.department || null, designation: l.designation || null,
  hasPhoto: !!l.photoDocId && canPhoto, cardType: l.cardType, cardsInOrder: l.cardsInOrder == null ? null : l.cardsInOrder, requestDate: tms(l.createdAt),
  status: l.status, printingStatus: CFG.IDCARD_PRINTING[l.status] || '-', deliveryStatus: CFG.IDCARD_DELIVERY[l.status] || '-',
  nextStatus: nextOf(l.status), completedOn: ['Ready', 'Delivered'].includes(l.status) ? tms(l.readyAt) : null, deliveredOn: l.status === 'Delivered' ? tms(l.deliveredAt) : null,
  waitingDays: ['New', 'Received', 'Printing'].includes(l.status) ? Math.max(0, Math.floor((Date.now() - (DB.toDate(l.orderCreatedAt) || new Date()).getTime()) / 86400000)) : null,
});
const SEL = 'SELECT l.*, o."orderCode", o."status", o."createdAt" AS "orderCreatedAt", o."readyAt", o."deliveredAt", (SELECT COUNT(*) FROM "IdCardOrderLine" x WHERE x."orderId" = o."id") AS "cardsInOrder"';

async function listRequests(v, perms, q = {}) {
  const ready = await DB.ready();
  if (!ready) return { rows: [], total: 0, page: 1, pages: 1, pageSize: 25, counts: { all: 0, pending: 0, completed: 0, delivered: 0 }, facets: { department: [], status: [], printing: [], delivery: [] }, notReady: true, canUpdate: perms.updateStatus, canDownload: perms.download };
  const w = where(v, q);
  const sortKey = SORTS[str(q.sort)] ? str(q.sort) : 'requestDate';
  const dir = str(q.dir) === 'asc' ? 'ASC' : (str(q.dir) === 'desc' ? 'DESC' : (sortKey === 'requestDate' ? 'DESC' : 'ASC'));
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || 25));
  const total = (await DB.one(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`, w.params)).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
  const rows = await DB.q(`${SEL} ${FROM} WHERE ${w.sql} ORDER BY ${SORTS[sortKey]} ${dir}, l."employeeName" ASC, l."id" ASC LIMIT ? OFFSET ?`, [...w.params, pageSize, (page - 1) * pageSize]);
  const facet = async (skip, expr) => {
    const f = where(v, q, skip);
    return (await DB.q(`SELECT ${expr} AS value, COUNT(*) AS count ${FROM} WHERE ${f.sql} AND ${expr} IS NOT NULL AND ${expr} <> '' GROUP BY ${expr} ORDER BY ${expr}`, f.params));
  };
  const byStatus = await facet('status', 'o."status"');
  const mapped = (list, map) => { const m = new Map(); list.forEach((x) => m.set(map[x.value], (m.get(map[x.value]) || 0) + x.count)); return [...m.entries()].map(([value, count]) => ({ value, count })); };
  const counts = await bucketCounts(v);
  return {
    rows: rows.map((l) => row(l, perms.download)), total, page, pageSize, pages, sort: sortKey, dir: dir.toLowerCase(), counts,
    facets: {
      // Only switched-on Department & Team names are offered (2026-10-28).
      department: await require('./masters').keepActiveDepartments(await facet('department', 'l."department"'), (o) => o.value, str(q.department)), // eslint-disable-line global-require
      status: byStatus.map((x) => ({ value: x.value, count: x.count })),
      printing: mapped(await facet('printing', 'o."status"'), CFG.IDCARD_PRINTING), delivery: mapped(await facet('delivery', 'o."status"'), CFG.IDCARD_DELIVERY),
    },
    canUpdate: perms.updateStatus, canDownload: perms.download, flow: FLOW,
  };
}

// The four numbers of the Dashboard, from the SAME rows the lists read.
async function bucketCounts(v) {
  if (!(await DB.ready())) return { all: 0, pending: 0, completed: 0, delivered: 0, byStatus: [] };
  const rows = await DB.q(`SELECT o."status" AS status, COUNT(*) AS n ${FROM} WHERE o."vendorId" = ? GROUP BY o."status"`, [v.vendorId]);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const sum = (list) => list.reduce((t, s) => t + (by[s] || 0), 0);
  return { all: sum(FLOW), pending: sum(CFG.IDCARD_BUCKETS.pending), completed: sum(CFG.IDCARD_BUCKETS.completed), delivered: sum(CFG.IDCARD_BUCKETS.delivered), byStatus: FLOW.map((st) => ({ value: st, count: by[st] || 0 })) };
}
async function overview(v, perms) {
  const counts = await bucketCounts(v);
  const ready = await DB.ready();
  const by = ready ? await DB.q('SELECT o."status" AS status, COUNT(*) AS n FROM "IdCardOrder" o WHERE o."vendorId" = ? GROUP BY o."status"', [v.vendorId]) : [];
  const orders = Object.fromEntries(by.map((r) => [r.status, r.n]));
  const recent = ready ? await DB.q(`${SEL} ${FROM} WHERE o."vendorId" = ? ORDER BY l."createdAt" DESC, l."employeeName" ASC LIMIT 5`, [v.vendorId]) : [];
  return {
    total: counts.all, pending: counts.pending, completed: counts.completed, delivered: counts.delivered, counts,
    byStatus: counts.byStatus, orders: { total: Object.values(orders).reduce((t, n) => t + n, 0), byStatus: orders },
    recent: recent.map((l) => row(l, perms.download)), canUpdate: perms.updateStatus,
  };
}

async function myLine(v, id) {
  if (!(await DB.ready())) return null;
  return DB.one(`SELECT l.*, o."orderCode", o."status", o."note", o."vendorRemarks", o."challanName", o."challanFile", o."createdByName", o."createdAt" AS "orderCreatedAt", o."receivedAt", o."printingAt", o."readyAt", o."deliveredAt" ${FROM} WHERE l."id" = ? AND o."vendorId" = ?`, [String(id || ''), v.vendorId]);
}
async function myOrder(v, id) {
  if (!(await DB.ready())) return null;
  return DB.one('SELECT * FROM "IdCardOrder" WHERE "id" = ? AND "vendorId" = ?', [String(id || ''), v.vendorId]);
}

async function requestDetail(v, perms, id) {
  const l = await myLine(v, id);
  if (!l) return null;
  const [events, siblings] = await Promise.all([
    DB.q('SELECT * FROM "IdCardOrderEvent" WHERE "orderId" = ? ORDER BY "createdAt" ASC', [l.orderId]),
    DB.one('SELECT COUNT(*) AS n FROM "IdCardOrderLine" WHERE "orderId" = ?', [l.orderId]),
  ]);
  return {
    request: {
      ...row(l, perms.download), bloodGroup: l.bloodGroup || null, orderNote: l.note || null, vendorRemarks: l.vendorRemarks || null,
      hasChallan: !!l.challanFile, challanName: l.challanName || null, cardsInOrder: siblings.n, nextButton: nextOf(l.status) ? NEXT_BUTTON[nextOf(l.status)] : null,
      dates: { requested: tms(l.orderCreatedAt), received: tms(l.receivedAt), printing: tms(l.printingAt), ready: tms(l.readyAt), delivered: tms(l.deliveredAt) },
    },
    history: events.map((e) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, by: e.actorKind === 'Vendor' ? 'You' : 'The company', byAccount: e.actorKind === 'Vendor' ? e.actorName : null, note: e.note || null, at: tms(e.createdAt) })),
    steps: FLOW, canUpdate: perms.updateStatus, canProof: perms.uploadProof, canDownload: perms.download,
  };
}

// Photo of one request (only the vendor's own line; the stored file is never exposed by name).
async function photoOf(v, perms, id) {
  if (!perms.download) return null;
  const l = await myLine(v, id);
  if (!l || !l.photoDocId) return null;
  const d = await prisma.employeeDocument.findFirst({ where: { id: l.photoDocId, employeeId: l.employeeId } });
  if (!d || !['image/jpeg', 'image/png', 'image/webp'].includes(d.mime)) return null;
  const full = attachments.resolveStored(d.file);
  return full ? { full, mime: d.mime } : null;
}

const CSV_HEAD = ['Employee ID', 'Name', 'Department', 'Designation', 'Request date', 'Request reference', 'Card type', 'ID card status', 'Printing status', 'Delivery status'];
async function exportRows(v, q, limit = 5000) { // limit: the shared Export (utils/vendorExport.js) asks for one more than its maximum, to refuse a list that is too big
  const w = where(v, q);
  const rows = await DB.q(`${SEL} ${FROM} WHERE ${w.sql} ORDER BY l."createdAt" DESC, l."employeeName" ASC LIMIT ${Math.max(1, Math.min(20000, Number(limit) || 5000))}`, w.params);
  return rows.map((l) => {
    const r = row(l, false);
    return [r.employeeCode, r.name, r.department, r.designation, r.requestDate ? r.requestDate.slice(0, 10) : '', r.requestRef, r.cardType, r.status, r.printingStatus, r.deliveryStatus];
  });
}

// ---- actions -------------------------------------------------------------------------------------
// ONE step forward on an order. The same status again changes nothing (no second history row).
// dry (the vendor Import's preview): check every rule, change NOTHING.
async function moveOrder(v, req, perms, id, want, remarks, { quiet = false, dry = false } = {}) {
  if (!perms.updateStatus) return { status: 403, body: { error: 'Your login cannot change the status. Ask the company.' } };
  const o = await myOrder(v, id);
  if (!o) return { status: 403, body: NOT_YOURS };
  if (!FLOW.includes(want)) return { status: 400, body: { error: 'Pick a proper status.', field: 'status' } };
  if (want === o.status) return { status: 200, body: { unchanged: true, orderId: o.id, orderCode: o.orderCode, status: o.status, message: `Order ${o.orderCode} is already ${want}.` } };
  const next = nextOf(o.status);
  if (!next) return { status: 409, body: { error: 'This order is already Delivered.' } };
  if (want !== next) return { status: 409, body: { error: `This order is ${o.status}. The next step is ${next}: steps cannot be skipped or taken back.`, expected: next } };
  if (VP.hasHtml(remarks)) return { status: 400, body: { error: 'Plain text only in the remark.', field: 'remarks' } };
  const note = VP.cleanText(remarks, 500);
  if (dry) return { status: 200, body: { dry: true, orderId: o.id, orderCode: o.orderCode, from: o.status, to: want } };
  const t = DB.now();
  const by = `${v.name} (vendor ${v.vendorName})`;
  const n = await DB.run(`UPDATE "IdCardOrder" SET "status" = ?, "${STAMP[want]}" = ?, "updatedAt" = ? WHERE "id" = ? AND "status" = ?`, [want, t, t, o.id, o.status]);
  if (!n) return { status: 409, body: { error: 'This order was just changed. Refresh and try again.' } };
  await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), o.id, o.status, want, 'Vendor', by, note || null, t]);
  await VP.auditReq(req, { vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: 'ID card order status changed', field: 'status', oldValue: o.status, newValue: want, status: o.orderCode });
  if (!quiet) {
    await VM.notifyCompany({
      creatorId: o.createdById, title: `ID card order ${o.orderCode} is now ${want}`, message: `${v.vendorName} marked ID card order ${o.orderCode} as ${want}.${note ? ` Remark: ${note}` : ''}`,
      task: { key: `ID cards ${o.orderCode}`, label: want, done: want === 'Delivered' },
    });
  }
  return { status: 200, body: { orderId: o.id, orderCode: o.orderCode, status: want, message: `Order ${o.orderCode} is now ${want}. The company has been told.` } };
}

// Several orders at once. EVERY id is checked on its own; one bad id never moves another, nothing is skipped silently.
async function bulkMove(v, req, perms, ids, want, remarks) {
  if (!perms.updateStatus) return { status: 403, body: { error: 'Your login cannot change the status. Ask the company.' } };
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(str).filter(Boolean))];
  if (!list.length) return { status: 400, body: { error: 'Select at least one request.' } };
  if (list.length > 100) return { status: 400, body: { error: 'Select up to 100 orders at a time.' } };
  const results = [];
  for (const id of list) {
    // eslint-disable-next-line no-await-in-loop
    const r = await moveOrder(v, req, perms, id, want, remarks, { quiet: true });
    results.push({ orderId: id, orderCode: r.body.orderCode || null, result: r.status === 200 ? (r.body.unchanged ? 'unchanged' : 'moved') : 'refused', status: r.body.status || null, error: r.status === 200 ? null : (r.status === 403 ? 'Not found.' : r.body.error) });
  }
  const moved = results.filter((r) => r.result === 'moved');
  if (results.every((r) => r.result === 'refused' && r.error === 'Not found.')) return { status: 403, body: NOT_YOURS };
  if (moved.length) {
    await VM.notifyCompany({ creatorId: null, title: `${moved.length} ID card ${moved.length === 1 ? 'order is' : 'orders are'} now ${want}`, message: `${v.vendorName} marked ${moved.map((m) => m.orderCode).join(', ')} as ${want}.` });
  }
  return { status: 200, body: { results, moved: moved.length, unchanged: results.filter((r) => r.result === 'unchanged').length, refused: results.filter((r) => r.result === 'refused').length, message: `${moved.length} moved to ${want}.` } };
}

async function saveProof(v, req, perms, id, remarks, st) {
  if (!perms.uploadProof) { if (st) attachments.remove(st.billFile); return { status: 403, body: { error: 'Your login cannot upload proof. Ask the company.' } }; }
  const o = await myOrder(v, id);
  if (!o) { if (st) attachments.remove(st.billFile); return { status: 403, body: NOT_YOURS }; }
  const t = DB.now();
  const old = o.challanFile;
  const by = `${v.name} (vendor ${v.vendorName})`;
  await DB.run('UPDATE "IdCardOrder" SET "vendorRemarks" = ?, "challanFile" = ?, "challanName" = ?, "challanMime" = ?, "challanSize" = ?, "updatedAt" = ? WHERE "id" = ?', [
    remarks || o.vendorRemarks || null, st ? st.billFile : o.challanFile, st ? st.billName : o.challanName, st ? st.billMime : o.challanMime, st ? st.billSize : o.challanSize, t, o.id]);
  if (st && old) attachments.remove(old);
  await DB.run('INSERT INTO "IdCardOrderEvent" ("id","orderId","fromStatus","toStatus","actorKind","actorName","note","createdAt") VALUES (?,?,?,?,?,?,?,?)', [DB.newId(), o.id, o.status, o.status, 'Vendor', by, `${st ? `Proof uploaded (${st.billName}). ` : ''}${remarks}`.trim(), t]);
  await VP.auditReq(req, { vendorId: v.vendorId, vendorUserId: v.userId, actorName: by, role: 'Vendor', action: st ? 'ID card order proof uploaded' : 'ID card order remark added', documentName: st ? st.billName : null, newValue: remarks || null, status: o.orderCode });
  await VM.notifyCompany({ creatorId: o.createdById, title: `ID card order ${o.orderCode}: note from the vendor`, message: `${v.vendorName} ${st ? 'uploaded a challan / proof' : 'added a remark'} on order ${o.orderCode}.${remarks ? ` ${remarks}` : ''}` });
  return { status: 201, body: { orderId: o.id, message: 'Saved. The company has been told.' } };
}

// ---- notices -------------------------------------------------------------------------------------
// The company's own entries in the history of THIS vendor's orders ("order placed ..."), newest first; read state per login.
async function notifications(v, userId) {
  if (!(await DB.ready())) return { rows: [], unread: 0 };
  await SCH.ensure();
  const ev = await DB.q(
    `SELECT e."id", e."orderId", e."note", e."createdAt", o."orderCode", o."status", (SELECT COUNT(*) FROM "IdCardOrderLine" l WHERE l."orderId" = o."id") AS cards,
       (SELECT 1 FROM "IdCardVendorNoticeRead" r WHERE r."eventId" = e."id" AND r."vendorUserId" = ?) AS isRead
     FROM "IdCardOrderEvent" e JOIN "IdCardOrder" o ON o."id" = e."orderId" WHERE o."vendorId" = ? AND e."actorKind" = 'Staff' ORDER BY e."createdAt" DESC LIMIT 50`, [userId, v.vendorId]);
  const rows = ev.map((e) => ({
    id: e.id, orderId: e.orderId, orderCode: e.orderCode, title: `New ID card order ${e.orderCode}`,
    text: `${e.note || 'The company placed an order with you.'}${e.status === 'New' ? ' It needs your action: mark it Received.' : ''}`, at: tms(e.createdAt), read: !!e.isRead, status: e.status,
  }));
  return { rows, unread: rows.filter((r) => !r.read).length };
}
async function markRead(v, userId, ids, all) {
  if (!(await DB.ready())) return { marked: 0 };
  await SCH.ensure();
  const mine = await DB.q('SELECT e."id" FROM "IdCardOrderEvent" e JOIN "IdCardOrder" o ON o."id" = e."orderId" WHERE o."vendorId" = ? AND e."actorKind" = \'Staff\'', [v.vendorId]);
  const ok = new Set(mine.map((m) => m.id));
  const want = all ? [...ok] : [...new Set((Array.isArray(ids) ? ids : []).map(str))].filter((i) => ok.has(i)); // an id that is not this vendor's is dropped silently
  const t = new Date().toISOString();
  let marked = 0;
  for (const id of want) {
    // eslint-disable-next-line no-await-in-loop
    marked += Number(await DB.run('INSERT OR IGNORE INTO "IdCardVendorNoticeRead" ("vendorUserId","eventId","readAt") VALUES (?,?,?)', [userId, id, t]));
  }
  return { marked };
}

// For the signed download of the delivery challan (kind po-challan): handled in routes/vendorPortal.js resolveOwnedFile (ownership by vendorId).

module.exports = {
  permsOf, listRequests, overview, bucketCounts, requestDetail, photoOf, exportRows, CSV_HEAD, moveOrder, bulkMove, saveProof, notifications, markRead, myOrder, nextOf, NOT_YOURS,
};
