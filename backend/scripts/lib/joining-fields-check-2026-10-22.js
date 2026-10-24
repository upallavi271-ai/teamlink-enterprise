/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// JOININGS SHEETS vs THE APP, FIELD BY FIELD (2026-10-22). Read only.
// For every imported row: each column of the sheet is compared with the place the import wrote it to:
//   candidate  name, phone, qualification, specialisation, designation, experience
//   application stage, interview date, salary (+ salary words), joining status, client (the job's client)
//   history    the recruiter, the TL, the seat, the invoice link, and "every cell of the row" in the history note
// Result words: OK | DIFFERENT | MISSING | NOT-LINKED | INFO (the app already had its own value; the import fills blanks only, it never overwrites)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const P = require('./joinings-2026-10-17/parse');
const JL = require('./joining-dates-sheet-2026-10-22');
const { invoiceKey } = require('./joinings-2026-10-17/state');
const { samePerson } = require('./joinings-2026-10-17/names');

const APPLIED = process.env.TL_JOININGS_APPLIED || 'C:/Users/user/Desktop/TeamLink-Joinings-Import-2026-10-17/applied';
const { oneLine, t } = P;

// small CSV reader (BOM, quotes, newlines inside quotes)
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const s = text.replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += ch; } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}
const readCsv = (name) => { const f = path.join(APPLIED, name); return fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : []; };

const same = (a, b) => oneLine(a).toLowerCase().replace(/[^a-z0-9]/g, '') === oneLine(b).toLowerCase().replace(/[^a-z0-9]/g, '');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function check({ prisma, parsed, db, rows, rowsOfApp }) {
  const recon = new Map(readCsv('02-reconciliation-every-row.csv').map((r) => [r.id, r]));
  const people = new Map(readCsv('06-people-recruiters-tls.csv').map((r) => [`${r.role}: ${r.written}`, r]));
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(APPLIED, 'undo-manifest.json'), 'utf8')); } catch { manifest = null; }
  const createdCand = new Set(manifest ? (manifest.created.candidate || []) : []);
  const createdApp = new Set(manifest ? (manifest.created.application || []) : []);
  const candIds = [...new Set([...db.byMarker.values()].map((f) => f.candidateId))];
  const cands = new Map();
  for (const part of JL.chunks(candIds, 400)) (await prisma.candidate.findMany({ where: { id: { in: part } } })).forEach((c) => cands.set(c.id, c));
  const notes = new Map();
  for (const part of JL.chunks(candIds, 400)) (await prisma.candidateNote.findMany({ where: { candidateId: { in: part } }, select: { candidateId: true, body: true } })).forEach((n) => { notes.set(n.candidateId, `${notes.get(n.candidateId) || ''}\n${n.body}`); });
  const appIds = [...new Set([...db.byMarker.values()].map((f) => f.applicationId))];
  const apps = new Map();
  for (const part of JL.chunks(appIds, 400)) (await prisma.application.findMany({ where: { id: { in: part } } })).forEach((a) => apps.set(a.id, a));
  const reqs = new Map();
  for (const part of JL.chunks([...new Set([...apps.values()].map((a) => a.requirementId))], 400)) (await prisma.requirement.findMany({ where: { id: { in: part } }, select: { id: true, clientId: true, title: true } })).forEach((r) => reqs.set(r.id, r));
  const invoices = await prisma.invoice.findMany({ select: { id: true, invoiceNumber: true, candidateId: true } });
  const invByNo = new Map();
  invoices.forEach((i) => { if (i.invoiceNumber) { const k = invoiceKey(i.invoiceNumber); if (!invByNo.has(k)) invByNo.set(k, []); invByNo.get(k).push(i); } });
  const isInvoiceNo = (s) => /^\d{3,5}$/.test(oneLine(s)) || /^[A-Z]{1,4}\d*-\d+(-\d+)?$/i.test(oneLine(s));
  const looksLikeNote = (s) => s.length > 24 || /\b20\d\d\b/.test(s) || /\b(called|through|mbl|whatsapp|received)\b/i.test(s);

  const all = []; const byRow = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of parsed.rows) {
    const fu = db.byMarker.get(r.id);
    if (!fu) continue;
    const a = apps.get(fu.applicationId); const c = cands.get(fu.candidateId);
    const rec = recon.get(r.id) || {};
    const f = r.f;
    const nm = oneLine(f.nameRaw);
    byRow.push({ id: r.id, sheet: r.sheetCode, name: nm });
    const add = (field, sheetValue, appValue, result, note = '') => all.push({ id: r.id, name: nm, field, sheetValue: String(sheetValue ?? ''), appValue: String(appValue ?? ''), result, note });
    if (!a || !c) { add('row', nm, '', 'NOT-FOUND', 'application or candidate is gone'); continue; }
    const candMade = createdCand.has(c.id); const appMade = createdApp.has(a.id);
    // the other sheet rows of the same application (the same person on several sheets): the app keeps the FIRST row's value
    const mates = (rowsOfApp && rowsOfApp.get(fu.applicationId) || []).filter((o) => o.id !== r.id);
    // a value that differs: a bug when the import made the record, otherwise the app already had its own value
    const cmp = (field, sheetValue, appValue, equal, made, note = '', alt = null) => {
      const sv = sheetValue === null || sheetValue === undefined ? '' : sheetValue;
      if (sv === '' || sv === null) { add(field, '', appValue, 'OK', 'sheet cell empty'); return; }
      if (appValue === null || appValue === undefined || appValue === '') { add(field, sv, '', 'MISSING', note || 'the sheet has it, the app field is empty'); return; }
      if (equal(sv, appValue)) { add(field, sv, appValue, 'OK', ''); return; }
      if (alt && mates.some((o) => { const x = alt(o.f); return x !== null && x !== undefined && x !== '' && equal(x, appValue); })) { add(field, sv, appValue, 'INFO', 'the app holds the value of another sheet row of the same person (the first row wins)'); return; }
      add(field, sv, appValue, made ? 'DIFFERENT' : 'INFO', made ? (note || 'record made by the import, value differs') : 'the app record already had its own value; the import only fills blanks');
    };
    // ---- candidate
    cmp('name', f.name, c.name, (x, y) => same(x, y) || samePerson(x, y), candMade);
    {
      const have = new Set(P.phonesIn(c.phone).list);
      if (!f.phones.length) add('phone', f.phoneRaw, c.phone, 'OK', 'no usable phone in the sheet');
      else if (f.phones.some((p) => have.has(p))) add('phone', f.phones.join(' / '), c.phone, 'OK', '');
      else if (f.phones.every((p) => (notes.get(c.id) || '').includes(p))) add('phone', f.phones.join(' / '), c.phone, 'OK', 'kept in a candidate note');
      else add('phone', f.phones.join(' / '), c.phone, candMade ? 'DIFFERENT' : 'INFO', 'phone not on the record');
    }
    cmp('qualification', f.qual, c.education, same, candMade, '', (g) => g.qual);
    cmp('specialisation', f.spec, c.specialization, same, candMade, '', (g) => g.spec);
    if (f.desig) cmp('designation', f.desig, c.currentDesignation, same, candMade, '', (g) => g.desig);
    if (f.expRaw) cmp('experience (years)', f.years, c.experienceYears, (x, y) => Math.abs(Number(x) - Number(y)) < 0.05, candMade, f.years === null ? 'experience words could not be turned into years' : '', (g) => g.years);
    // ---- application
    const ans = byId.get(r.id);
    const v = ans ? ans._verdict : JL.verdictOf(r);
    if (!v.unknown) {
      const joinedApp = JL.isJoinedStage(a.stage);
      if (v.joined) add('stage', v.says, a.stage, joinedApp ? 'OK' : 'DIFFERENT', joinedApp ? '' : 'sheet says joined; the application is not Joined');
      else if (joinedApp && ans && ans.status === JL.STATUS.EARLIER_STEP) add('stage', v.says, a.stage, 'OK', 'an earlier step of a person who is Joined');
      else add('stage', v.says, a.stage, joinedApp ? 'DIFFERENT' : 'OK', joinedApp ? 'the application is Joined; the sheet row says it is not a joining' : '');
    }
    {
      const iv = f.ivIso;
      const ivOk = iv && (!f.joinIso || iv <= f.joinIso) && iv <= '2026-10-17';
      if (!f.ivRaw) add('interview date', '', a.interviewAt ? a.interviewAt.toISOString().slice(0, 10) : '', 'OK', 'sheet cell empty');
      else if (!iv) add('interview date', f.ivRaw, a.interviewAt ? a.interviewAt.toISOString().slice(0, 10) : '', 'INFO', 'the sheet text is not a readable date (kept in the history note)');
      else if (!ivOk) add('interview date', iv, a.interviewAt ? a.interviewAt.toISOString().slice(0, 10) : '', 'INFO', 'the sheet interview day is after the joining day: not put on the application, kept in the note');
      else if (!a.interviewAt) add('interview date', iv, '', 'MISSING', 'the sheet has an interview day; the application has none');
      else cmp('interview date', iv, a.interviewAt.toISOString().slice(0, 10), same, appMade, '', (g) => g.ivIso);
    }
    if (f.sal.raw) {
      if (f.sal.monthly) {
        cmp('salary (per year)', f.sal.monthly * 12, a.offeredCtc, (x, y) => Math.abs(Number(x) - Number(y)) < 1, appMade, '', (g) => (g.sal.monthly ? g.sal.monthly * 12 : null));
      } else add('salary (per year)', f.sal.raw, a.offeredCtc, 'INFO', `"${f.sal.raw}" is ${f.sal.quality} (no single number): kept as words`);
      const inNote = (a.offerNotes || '').includes(f.sal.raw);
      const inFu = (fu.notes || '').includes(f.sal.raw);
      add('salary words', f.sal.raw, a.offerNotes || '', inNote || inFu ? 'OK' : 'MISSING', inNote ? '' : (inFu ? 'only in the history note (the application already had its own salary note)' : 'salary words not found'));
    }
    // ---- client
    {
      const rq = reqs.get(a.requirementId);
      add('client / college', f.clientRaw, rq ? rq.clientId : '', rec.clientId && rq && rec.clientId === rq.clientId ? 'OK' : (rec.clientId ? 'DIFFERENT' : 'NOT-FOUND'), rec.clientId && rq && rec.clientId !== rq.clientId ? `import mapped the row to client ${rec.clientId}; the application is at ${rq.clientId}` : '');
      add('client name now', f.clientRaw, (db.clients.get(rq ? rq.clientId : '') || {}).name || '', 'OK', 'for reading');
    }
    // ---- people + seat
    {
      const rawRec = f.recruiterRaw && !looksLikeNote(f.recruiterRaw) ? oneLine(f.recruiterRaw) : '';
      if (rawRec) {
        const m = people.get(`recruiter: ${rawRec}`);
        const mapped = m && /^[A-Z]*\d+ /.test(m.mappedTo || '') ? m.mappedTo.replace(/^\S+ /, '') : rawRec;
        add('recruiter', rawRec, fu.ownerName || '', fu.ownerName && same(fu.ownerName, mapped) ? 'OK' : (fu.ownerName ? 'DIFFERENT' : 'MISSING'), m ? `mapped to ${m.mappedTo}` : '');
      } else if (f.recruiterRaw) add('recruiter', f.recruiterRaw, fu.ownerName || '', 'OK', 'the cell is a note, not a name: kept in the history note');
      if (f.tlRaw) {
        const m = people.get(`tl: ${oneLine(f.tlRaw)}`);
        const mapped = m && /^[A-Z]*\d+ /.test(m.mappedTo || '') ? m.mappedTo.replace(/^\S+ /, '') : oneLine(f.tlRaw);
        add('TL', oneLine(f.tlRaw), fu.tlName || '', fu.tlName && same(fu.tlName, mapped) ? 'OK' : (fu.tlName ? 'DIFFERENT' : 'MISSING'), m ? `mapped to ${m.mappedTo}` : '');
      }
      if (f.seat) add('seat', f.seatRaw || f.roleRaw, fu.ownerPositionCode || '', fu.ownerPositionCode === f.seat ? 'OK' : (fu.ownerPositionCode ? 'DIFFERENT' : 'MISSING'), '');
    }
    // ---- invoice
    if (f.invoiceRaw) {
      if (!isInvoiceNo(f.invoiceRaw)) add('invoice no', f.invoiceRaw, '', 'OK', 'the cell is not an invoice number (kept in the note)');
      else {
        const list = invByNo.get(invoiceKey(f.invoiceRaw)) || [];
        if (!list.length) add('invoice no', f.invoiceRaw, '', 'INFO', 'no invoice with this number in Accounts (number kept in the history note)');
        else if (list.some((i) => i.candidateId === c.id)) add('invoice no', f.invoiceRaw, 'linked', 'OK', '');
        else if (list.every((i) => i.candidateId && i.candidateId !== c.id)) add('invoice no', f.invoiceRaw, 'on another candidate', 'INFO', 'one invoice for several joinings: the number is on the invoice of another candidate (the import never changes it)');
        else add('invoice no', f.invoiceRaw, list.map((i) => i.candidateId || '(none)').join(','), 'NOT-LINKED', list.length > 1 ? 'the number is on several invoices; not linked' : 'the invoice has no candidate; the import did not link it');
      }
    }
    // ---- every cell of the row is in the history note
    {
      const hdr = parsed.headers[r.sheetCode] || {};
      const missing = [];
      Object.entries(r.cells).forEach(([L2, cell]) => {
        const label = hdr[L2] || `Column ${L2} (no heading)`;
        const val = cell.t === 'n' && /d|m|y/i.test(String(cell.z || '')) && !/^0|General/.test(String(cell.z || '')) ? `${cell.w}` : t(cell.v);
        if (!(fu.notes || '').includes(`${label}: ${val}`)) missing.push(label);
      });
      add('every cell kept in the history note', `${Object.keys(r.cells).length} cells`, missing.length ? `missing: ${missing.join(', ')}` : 'all there', missing.length ? 'MISSING' : 'OK', '');
    }
    // ---- joining status words
    if (!v.unknown && JL.isJoinedStage(a.stage) && v.joined) {
      const left = ['Dropped', 'Replacement Due', 'Replaced', 'Left after Guarantee'].includes(a.joiningStatus);
      const want = v.left ? 'left' : 'still there';
      add('joining status (Joined / Dropped)', v.says, a.joiningStatus || '(none)', (v.left && left) || (!v.left && !left) ? 'OK' : 'INFO', (v.left && left) || (!v.left && !left) ? '' : `sheet says ${want}; the app says "${a.joiningStatus || 'nothing'}" (set by someone in the app)`);
    }
  }
  return { all, byRow, byId };
}

function summarise(list) {
  const o = {};
  list.forEach((x) => {
    if (x.field === 'client name now') return;
    const s = o[x.field] = o[x.field] || { ok: 0, bad: 0, info: 0 };
    if (x.result === 'OK') s.ok += 1; else if (x.result === 'INFO') s.info += 1; else s.bad += 1;
  });
  return o;
}

module.exports = { check, summarise, parseCsv, readCsv };
