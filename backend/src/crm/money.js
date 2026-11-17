// ---------------------------------------------------------------------------
// THE CRM MONEY PATH, SLICE 2 (2026-11-17). Everything stays in the CRM's own raw-SQL tables (crm/schema.js) - never the ATS Accounts
// Invoice / Client ("crm mottham separate application"). What is here:
//   GST split        CGST + SGST (half each) when the customer is in our state, IGST when not; the state comes from the customer's GSTIN
//                    (its first two digits), else from the account's state; unknown -> IGST and flagged. Worked out on READ from the
//                    invoice's own from / bill-to copies, so an old invoice shows its split without any amount being rewritten.
//   numbering        a format setting like INV/{FY}/{0000}: the Indian financial year (April - March, 2026-27) and a number that starts
//                    again each year. '' keeps today's INV-0001. Old codes are never changed.
//   invoice lines    description, SAC, qty, rate - editable while the invoice is a Draft (totals recomputed), read-only once Sent
//   TDS              worked out for a payment line from a % (on the value before GST of what the line settles)
//   overdue alert    an invoice past its due date with money owed: one bell to its owner and the Sales managers, every 3 days at most
//   deal files       a quotation (PDF / Word / Excel / image, at most 10 MB) kept on a deal: list, download, delete
//   lost re-check    a deal marked Lost gets a follow-up for its owner 90 days later (once)
// ---------------------------------------------------------------------------
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const cents = (n) => Math.round(Number(n || 0) * 100) / 100;

// ---- GST: states -------------------------------------------------------------------------------------------
// The GST state codes (the first two digits of a GSTIN).
const STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram',
  16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal', 20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh',
  24: 'Gujarat', 26: 'Dadra and Nagar Haveli and Daman and Diu', 27: 'Maharashtra', 29: 'Karnataka', 30: 'Goa', 31: 'Lakshadweep',
  32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory',
};
const squash = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const NAME_TO_CODE = Object.fromEntries(Object.entries(STATE_CODES).map(([c, n]) => [squash(n), String(c).padStart(2, '0')]));
Object.assign(NAME_TO_CODE, {
  orissa: '21', pondicherry: '34', newdelhi: '07', nctofdelhi: '07', nctdelhi: '07', jandk: '01', damananddiu: '26', dadraandnagarhaveli: '26', andamanandnicobar: '35',
  ap: '37', ts: '36', tg: '36', tn: '33', ka: '29', mh: '27', kl: '32', dl: '07', up: '09', mp: '23', wb: '19', gj: '24', rj: '08', hr: '06', pb: '03', or: '21', od: '21', br: '10', ga: '30', jh: '20', cg: '22', ct: '22', uk: '05', ut: '05', as: '18',
});
const stateName = (code) => (code ? STATE_CODES[code] || STATE_CODES[Number(code)] || null : null);
/** A GSTIN in the usual shape (15 characters, two digits of a known state first)? */
function validGstin(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(s) && !!stateName(s.slice(0, 2));
}
/** '36' for a GSTIN of Telangana; null when it is not a GSTIN. */
const gstinStateCode = (v) => (validGstin(v) ? String(v).trim().slice(0, 2) : null);
/** The two-digit code of a state written as a name ('Telangana', 'TS'), a code ('36', '36 - Telangana'), or null. */
function stateCodeOf(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})\b/.exec(s);
  if (m) { const c = m[1].padStart(2, '0'); return stateName(c) ? c : null; }
  return NAME_TO_CODE[squash(s)] || null;
}
/** Which state a party (our company, or the customer) is in: its GSTIN first, else the state written on it. */
function partyState(p) {
  const fromGstin = gstinStateCode(p && p.gstin);
  if (fromGstin) return { code: fromGstin, how: 'GSTIN' };
  const c = stateCodeOf(p && (p.stateCode || p.state));
  return c ? { code: c, how: 'state' } : { code: null, how: null };
}

/**
 * The GST split of one invoice. `tax` is the invoice's tax in rupees (already rounded to paise); the halves are split in PAISE so CGST + SGST is
 * always exactly the tax (an odd paisa goes to CGST) and amount + tax is the total. Returns
 * { mode: 'intra' | 'inter' | 'none', cgst, sgst, igst, rate, halfRate, ourState, customerState, placeOfSupply, flag }.
 */
function gstSplit({ tax, taxPercent, from = {}, billTo = {} }) {
  const P = Math.round((Number(tax) || 0) * 100);
  const rate = Number(taxPercent) || 0;
  const ours = partyState(from); const theirs = partyState(billTo);
  const base = { rate, halfRate: rate / 2, ourState: ours.code ? { code: ours.code, name: stateName(ours.code), how: ours.how } : null, customerState: theirs.code ? { code: theirs.code, name: stateName(theirs.code), how: theirs.how } : null };
  base.placeOfSupply = base.customerState ? { code: theirs.code, name: stateName(theirs.code) } : null;
  if (!P) return { ...base, mode: 'none', cgst: 0, sgst: 0, igst: 0, flag: null };
  let flag = null;
  if (!theirs.code) flag = 'The customer\'s state is not known (no GSTIN and no state on the account): IGST is charged. Add the state or GSTIN on the account.';
  else if (!ours.code) flag = 'Our company\'s state is not set (CRM settings > Invoices): IGST is charged until it is.';
  if (!flag && ours.code === theirs.code) {
    const c = Math.round(P / 2);
    return { ...base, mode: 'intra', cgst: c / 100, sgst: (P - c) / 100, igst: 0, flag: null };
  }
  return { ...base, mode: 'inter', cgst: 0, sgst: 0, igst: P / 100, flag };
}

// ---- invoice numbering: the Indian financial year -----------------------------------------------------------
/** The financial year (April - March) of a date: '2026-03-31' -> '2025-26', '2026-04-01' -> '2026-27'. */
function fyOf(ymd) {
  const [y, m] = String(ymd || '').slice(0, 10).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
/** 'INV/{FY}/{0000}' with fy 2026-27 and n 7 -> 'INV/2026-27/0007'. */
function formatInvoiceCode(fmt, { fy, n }) {
  return String(fmt)
    .replace(/\{FY\}/g, fy)
    .replace(/\{FY2\}/g, `${fy.slice(2, 4)}-${fy.slice(5, 7)}`)
    .replace(/\{(0+)\}/, (_, z) => String(n).padStart(z.length, '0'));
}
const SEQ_KEY = 'crm.seq';
/** The code for a new invoice dated `issueDate`: INV-0001 style while no format is set, else the format with its own running number
 * (one per financial year when the format has {FY} / {FY2}). A code that is already taken is skipped. */
async function nextInvoiceCode(issueDate) {
  const st = await SETTINGS.load();
  const fmt = st.invoiceNumberFormat;
  if (!fmt) { const [code] = await S.nextCodes('invoice', 1); return code || null; }
  const fy = fyOf(issueDate || S.istToday());
  const key = /\{FY2?\}/.test(fmt) ? `invoice@${fy}` : `invoice@${fmt}`;
  const row = await prisma.appSetting.findUnique({ where: { key: SEQ_KEY } }).catch(() => null);
  let seq = {}; try { seq = row && row.value ? JSON.parse(row.value) : {}; } catch { seq = {}; }
  let n = Number(seq[key]) || 0;
  let code;
  for (let i = 0; i < 1000; i += 1) {
    n += 1; code = formatInvoiceCode(fmt, { fy, n });
    // eslint-disable-next-line no-await-in-loop
    if (!(await DB.one('SELECT 1 AS "x" FROM "CrmInvoice" WHERE "code" = ?', code))) break;
  }
  seq[key] = n;
  await prisma.appSetting.upsert({ where: { key: SEQ_KEY }, create: { key: SEQ_KEY, value: JSON.stringify(seq) }, update: { value: JSON.stringify(seq) } });
  return code;
}

// ---- invoice lines ---------------------------------------------------------------------------------------------
/** The lines of an invoice: its own, or (an invoice from before lines) one line made from its title and amount. */
function linesOf(row, st = SETTINGS.current()) {
  let lines = null;
  try { lines = row.linesJson ? JSON.parse(row.linesJson) : null; } catch { lines = null; }
  if (Array.isArray(lines) && lines.length) return lines;
  let from = {}; try { from = row.fromJson ? JSON.parse(row.fromJson) : {}; } catch { from = {}; }
  const amount = cents(row.amount);
  return [{ description: row.title || 'Services', sac: from.sac || st.invoiceSac, qty: 1, rate: amount, amount }];
}
function cleanLines(list) {
  if (!Array.isArray(list) || !list.length) return { error: 'Add at least one line.' };
  if (list.length > 30) return { error: 'At most 30 lines.' };
  const out = [];
  for (const [i, x] of list.entries()) {
    const description = S.clip(x && x.description, 300);
    const sac = String((x && x.sac) == null ? '' : x.sac).trim();
    const qty = Number(String((x && x.qty) == null ? '' : x.qty).replace(/[, ]/g, ''));
    const rate = Number(String((x && x.rate) == null ? '' : x.rate).replace(/[, ]/g, ''));
    if (!description) return { error: `Line ${i + 1}: write what it is for.` };
    if (sac && !/^\d{4,8}$/.test(sac)) return { error: `Line ${i + 1}: the SAC code is 4 to 8 digits (like 998314).` };
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6) return { error: `Line ${i + 1}: the quantity must be more than 0.` };
    if (!Number.isFinite(rate) || rate < 0 || rate > 1e11) return { error: `Line ${i + 1}: write the rate in rupees.` };
    out.push({ description, sac: sac || null, qty: Math.round(qty * 1000) / 1000, rate: cents(rate), amount: cents(qty * rate) });
  }
  return { lines: out };
}
/** Change a DRAFT invoice: { lines, notes, dueDate }. The amount, tax and total are worked out again; a sent invoice is read-only. */
async function editDraft(user, id, body = {}) {
  const r = S.roleOf(user);
  const row = await DB.one('SELECT * FROM "CrmInvoice" WHERE "id" = ?', S.clip(id, 60));
  if (!row || !S.canSeeRow(user, r, row)) return S.fail(404, 'This invoice is not there.');
  if (!S.canEditRow(user, r, row)) return S.fail(403, 'You cannot change this invoice.');
  if (row.status !== 'Draft') return S.fail(409, `${row.code || 'This invoice'} is ${row.status}: it went to the customer and cannot be changed now.`, { locked: true });
  const data = { updatedAt: DB.nowIso() };
  if ('lines' in body) {
    const c = cleanLines(body.lines);
    if (c.error) return S.fail(400, c.error);
    const amount = cents(c.lines.reduce((n, x) => n + x.amount, 0));
    const taxAmount = cents(amount * ((Number(row.taxPercent) || 0) / 100));
    Object.assign(data, { linesJson: JSON.stringify(c.lines), amount, taxAmount, total: cents(amount + taxAmount), discountPercent: null });
  }
  if ('notes' in body) data.notes = S.clip(body.notes, 2000);
  if ('dueDate' in body) {
    const d = S.clip(body.dueDate, 10);
    if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) return S.fail(400, 'Pick a proper due date.');
    if (d && d < row.issueDate) return S.fail(400, 'The due date cannot be before the invoice date.');
    data.dueDate = d || null;
  }
  // while it is a Draft the customer's details are copied again from the account (a GSTIN or state added after Won reaches the invoice)
  if (row.accountId) {
    const a = await S.getRow('account', row.accountId).catch(() => null);
    if (a) data.billToJson = JSON.stringify({ name: a.name, gstin: a.gstin || '', address: a.address || '', state: a.state || '', pincode: a.pincode || '', email: a.email || '', phone: a.phone || '' });
  }
  const saved = await S.update('CrmInvoice', row.id, data);
  await S.audit(user, 'CRM invoice draft changed', 'CrmInvoice', row.id, `${row.code || row.id}: ${row.total} -> ${saved.total}`);
  return S.okBody({ ok: true, invoice: await S.invoiceFull(saved) });
}

// ---- TDS --------------------------------------------------------------------------------------------------------
/** The TDS a line carries when it is given as a % (of the value BEFORE GST of what the line settles): 10% TDS on Rs 1,00,000 + 18% GST paid as
 * Rs 1,08,000 cash -> Rs 10,000. `cash` is the money received on the line; `amount` / `total` are the invoice's value before tax and its total. */
function tdsFromPercent({ cash, percent, amount, total }) {
  const k = ((Number(percent) || 0) / 100) * ((Number(total) ? Number(amount) / Number(total) : 1));
  if (!(k > 0) || k >= 1) return 0;
  return cents((k * (Number(cash) || 0)) / (1 - k));
}

// ---- the overdue alert ------------------------------------------------------------------------------------------
/** One pass (10:00 India time each day, routes/crm.js): every invoice that went out (Sent / Partly paid), is past its due date and still has money
 * owed gets ONE bell to its owner and the Sales managers - and again only 3 days after the last one. -> the number of invoices told. */
async function escalateOverdueInvoices({ now = Date.now(), notify } = {}) {
  const st = await SETTINGS.load();
  if (st.overdueInvoiceAlert === false) return 0;
  const today = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
  const again = new Date(now - 3 * 86400000).toISOString();
  const rows = await DB.all(`SELECT * FROM "CrmInvoice" WHERE "status" IN ('Sent', 'Partly paid') AND "dueDate" IS NOT NULL AND "dueDate" < ?
    AND "total" - "paidAmount" - COALESCE("tdsAmount", 0) > 0.004 AND ("overdueAlertAt" IS NULL OR "overdueAlertAt" <= ?) ORDER BY "dueDate" ASC LIMIT 300`, today, again);
  if (!rows.length) return 0;
  const managers = await require('./sales').managersToTell().catch(() => []); // eslint-disable-line global-require
  const send = notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
  const inr = (v) => `Rs. ${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  let told = 0;
  for (const inv of rows) {
    const to = [...new Set([inv.ownerId, ...managers].filter(Boolean))];
    if (!to.length) continue; // eslint-disable-line no-continue
    // claimed first: two passes can never both tell
    // eslint-disable-next-line no-await-in-loop
    const claimed = await DB.run('UPDATE "CrmInvoice" SET "overdueAlertAt" = ? WHERE "id" = ? AND ("overdueAlertAt" IS NULL OR "overdueAlertAt" <= ?)', new Date(now).toISOString(), inv.id, again);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    const late = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${inv.dueDate}T00:00:00Z`)) / 86400000));
    const balance = cents(inv.total - inv.paidAmount - (Number(inv.tdsAmount) || 0));
    // eslint-disable-next-line no-await-in-loop
    await send(to, { title: `⚠️ Invoice ${inv.code || ''} overdue — ${inv.accountName || 'a customer'}`, message: `${inr(balance)} still to come, due ${inv.dueDate} (${late} day${late === 1 ? '' : 's'} late). Owner: ${inv.ownerName || '-'}.\nOpen: /crm/deals?open=deal:${inv.dealId}` }).catch(() => null);
    told += 1;
  }
  return told;
}

// ---- files on a deal (the quotation) ------------------------------------------------------------------------------
const FILE_MAX = 10 * 1024 * 1024;
const FILE_KINDS = ['Quotation', 'Purchase order', 'Other'];
const EXT_MIME = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const FILE_WORDS = {
  NO_FILE: 'Choose a file to upload.',
  TOO_LARGE: 'That file is larger than 10 MB.',
  BAD_TYPE: 'Only PDF, Word (DOC / DOCX), Excel (XLS / XLSX / CSV) and pictures (PNG / JPEG / WebP) can be kept on a deal.',
  CONTENT_MISMATCH: 'That file\'s contents do not match its type (is it really a PDF / Word / Excel file?).',
  NOT_MULTIPART: 'Upload the file as a form (multipart/form-data).',
};
const fileOut = (f) => ({ id: f.id, dealId: f.dealId, kind: f.kind, name: f.name, mime: f.mime, size: f.size, byName: f.createdByName || null, createdAt: f.createdAt });
async function dealFor(user, dealId, { edit } = {}) {
  const r = S.roleOf(user);
  const deal = await S.getRow('deal', dealId);
  if (!deal || !S.canSeeRow(user, r, deal)) return { error: S.fail(404, 'This deal is not there, or it is not yours.') };
  if (edit && !S.canEditRow(user, r, deal)) return { error: S.fail(403, 'You can read this deal but not change its files.') };
  return { deal };
}
async function dealFiles(user, dealId) {
  const x = await dealFor(user, dealId);
  if (x.error) return x.error;
  const rows = await DB.all('SELECT * FROM "CrmDealFile" WHERE "dealId" = ? ORDER BY "createdAt" DESC', x.deal.id);
  return S.okBody({ files: rows.map(fileOut), canEdit: S.canEditRow(user, S.roleOf(user), x.deal), maxBytes: FILE_MAX, kinds: FILE_KINDS });
}
/** The upload itself (the route hands the request): one file, at most 10 MB, PDF / Word / Excel / picture, its first bytes checked. */
async function uploadDealFile(user, dealId, req) {
  const x = await dealFor(user, dealId, { edit: true });
  if (x.error) { req.resume(); return x.error; }
  const A = require('../utils/attachments'); // eslint-disable-line global-require
  let parsed;
  try { parsed = await A.parseMultipart(req, { maxBytes: FILE_MAX }); } catch (e) {
    // refused from the declared size before a byte was read: the rest of the body is let through (and dropped) so the answer arrives
    if (!req.complete && !req.destroyed) { req.resume(); await new Promise((r) => { req.once('end', r); req.once('error', r); setTimeout(r, 15000); }); }
    return S.fail(e.code === 'TOO_LARGE' ? 413 : 400, FILE_WORDS[e.code] || 'The file could not be read.');
  }
  const file = parsed.file;
  if (file && (!file.contentType || file.contentType === 'application/octet-stream')) {
    const ext = String(file.filename || '').toLowerCase().split('.').pop();
    if (EXT_MIME[ext]) file.contentType = EXT_MIME[ext];
  }
  let saved;
  try { saved = A.store(file, { maxBytes: FILE_MAX, allowWord: true, allowSheet: true }); } catch (e) { return S.fail(e.code === 'TOO_LARGE' ? 413 : 400, FILE_WORDS[e.code] || 'The file could not be kept.'); }
  const kind = FILE_KINDS.includes(parsed.fields.kind) ? parsed.fields.kind : 'Quotation';
  const now = DB.nowIso();
  const row = await S.insert('CrmDealFile', { id: S.newId('dfile'), dealId: x.deal.id, accountId: x.deal.accountId || null, kind, name: saved.billName, mime: saved.billMime, size: saved.billSize, stored: saved.billFile, createdById: user.id, createdByName: user.name || null, createdAt: now });
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `${kind} uploaded: ${row.name}`, note: `${Math.max(1, Math.round(row.size / 1024))} KB`, at: now, dealId: x.deal.id, accountId: x.deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, 'CRM deal file uploaded', 'CrmDealFile', row.id, `${x.deal.title}: ${row.name}`);
  return S.okBody({ ok: true, file: fileOut(row) });
}
async function fileRow(user, fileId, { edit } = {}) {
  const f = await DB.one('SELECT * FROM "CrmDealFile" WHERE "id" = ?', S.clip(fileId, 60));
  if (!f) return { error: S.fail(404, 'This file is not there.') };
  const x = await dealFor(user, f.dealId, { edit });
  return x.error ? { error: x.error } : { f, deal: x.deal };
}
/** -> { status: 200, path, name, mime } for the route to stream, or an error. */
async function dealFileDownload(user, fileId) {
  const x = await fileRow(user, fileId);
  if (x.error) return x.error;
  const full = require('../utils/attachments').resolveStored(x.f.stored); // eslint-disable-line global-require
  if (!full) return S.fail(404, 'The file is missing on the server.');
  return { status: 200, path: full, name: x.f.name, mime: x.f.mime };
}
async function deleteDealFile(user, fileId) {
  const x = await fileRow(user, fileId, { edit: true });
  if (x.error) return x.error;
  await DB.run('DELETE FROM "CrmDealFile" WHERE "id" = ?', x.f.id);
  require('../utils/attachments').remove(x.f.stored); // eslint-disable-line global-require
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind: 'note', subject: `${x.f.kind} removed: ${x.f.name}`, note: null, at: now, dealId: x.deal.id, accountId: x.deal.accountId, byId: user.id, byName: user.name || null, createdAt: now });
  await S.audit(user, 'CRM deal file deleted', 'CrmDealFile', x.f.id, `${x.deal.title}: ${x.f.name}`);
  return S.okBody({ ok: true });
}

// ---- Lost -> look at it again in three months ------------------------------------------------------------------
const RECHECK_DAYS = 90;
/** A deal just marked Lost: a follow-up for its owner 90 days on, "Re-check <account>: lost because <reason>". Once (an open one is kept);
 * CRM settings > "Re-check lost deals" turns it off. -> the follow-up, or null. */
async function lostRecheck(user, deal, reason) {
  if (!deal || !deal.id) return null;
  const st = await SETTINGS.load();
  if (st.lostRecheck === false) return null;
  const open = await DB.one('SELECT * FROM "CrmTask" WHERE "dealId" = ? AND "origin" = \'lost-recheck\' AND "status" = \'Open\'', deal.id);
  if (open) return open;
  const acc = deal.accountId ? await S.getRow('account', deal.accountId).catch(() => null) : null;
  const now = DB.nowIso();
  const due = new Date(Date.parse(`${S.istToday()}T00:00:00Z`) + RECHECK_DAYS * 86400000).toISOString().slice(0, 10);
  const extras = await require('./sales').taskExtras({ type: 'Call', priority: 'Medium' }); // eslint-disable-line global-require
  return S.insert('CrmTask', {
    id: S.newId('task'), title: `Re-check ${(acc && acc.name) || deal.title}: lost because ${reason || 'no reason given'}`.slice(0, 200), dueDate: due, dueTime: '10:00', ...extras,
    status: 'Open', leadId: null, accountId: deal.accountId || null, dealId: deal.id, origin: 'lost-recheck',
    ownerId: deal.ownerId || user.id, ownerName: deal.ownerName || user.name || null, createdById: user.id, createdAt: now, updatedAt: now,
  });
}

module.exports = {
  STATE_CODES, stateName, validGstin, gstinStateCode, stateCodeOf, partyState, gstSplit,
  fyOf, formatInvoiceCode, nextInvoiceCode, validInvoiceFormat: SETTINGS.validInvoiceFormat,
  linesOf, cleanLines, editDraft, tdsFromPercent, escalateOverdueInvoices,
  FILE_MAX, dealFiles, uploadDealFile, dealFileDownload, deleteDealFile, lostRecheck, RECHECK_DAYS,
};
