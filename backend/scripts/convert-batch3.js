// ---------------------------------------------------------------------------
// CONVERTS THE THIRD BATCH into the import template.
//
//   node scripts/convert-batch3.js <out.xlsx>
//
//   Invoice 2026                      -> INVOICES (the first Accounts data)
//   BDE-Edu-Profile Screening         -> education candidates + applications
//   BDE MED Worksheet                 -> medical candidates + applications,
//                                        and real commercial terms per client
//   Manufacture Client Follow Up      -> manufacturing candidates + applications
//
// Same approach as batches 1 and 2: map into the template, let the validated
// importer write. Reads the database read-only so an existing client,
// requirement or candidate is REUSED rather than created a second time.
//
// WHAT IS NEW HERE
//
//   INVOICES. The sheet records CGST, SGST and TDS as AMOUNTS and the app
//   stores percentages alongside them, so the percentage is derived from what
//   was actually charged rather than assumed to be 18 and 10 — some rows are
//   18% GST with no TDS, others 10% TDS with no GST, and writing the assumed
//   figure would silently restate somebody's books.
//
//   CLIENT COMMERCIAL TERMS. "Client Follow Up Sheet" carries the fee ("6%+GST
//   18% for all profiles"), the agreement date, the contact person, their
//   number, designation and email. That is real client data the earlier
//   batches did not have, and it enriches clients that already exist.
// ---------------------------------------------------------------------------

const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const prisma = require('../src/db');
const { buildTemplate } = require('../src/utils/importTemplate');
const { nkey, preferred, tidyName, firstPhone, mapStatus } = require('../src/utils/importNormalise');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/convert-batch3.js <out.xlsx>'); process.exit(1); }
const DIR = 'C:/Users/user/Downloads/';

const txt = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.hyperlink !== undefined) return String(v.text || v.hyperlink);
    return String(v.text !== undefined ? v.text : (v.result !== undefined ? v.result : ''));
  }
  return String(v);
};
const clean = (v) => txt(v).replace(/\s+/g, ' ').trim();
const cellOf = (ws, r, n) => (n ? clean(ws.getRow(r).getCell(n).value) : '');

function headerIndex(ws, row = 1) {
  const ix = {};
  ws.getRow(row).eachCell({ includeEmpty: true }, (c, n) => { const t = clean(c.value); if (t && !ix[t]) ix[t] = n; });
  return ix;
}
function col(ix, ...names) {
  for (const n of names) {
    if (ix[n]) return ix[n];
    const hit = Object.keys(ix).find((k) => nkey(k) === nkey(n));
    if (hit) return ix[hit];
  }
  return 0;
}
function asDate(v) {
  const s = clean(v);
  if (!s) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    const dd = Number(d); const mm = Number(mo);
    if (dd > 31 || mm > 12 || dd < 1 || mm < 1) return '';
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return '';
}
// A money cell. These sheets hold "170,00,00", "2,2,0000", "Didn't mentioned"
// and "25% on current CTC" — anything that is not a plain number is left blank
// and kept as text elsewhere rather than guessed at.
function money(v) {
  const s = clean(v).replace(/[₹,\s]/g, '');
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const clients = new Map();
const specs = new Map();
const people = new Map();
const reqs = new Map();
const cands = new Map();
const apps = new Map();
const invoices = new Map();
const existingReqs = new Map();
const existingCands = new Set();
const takenCodes = new Set();
const takenInvoices = new Set();
const stats = { sources: [], skipped: [], unknownStatus: new Map(), noKeyCandidates: 0, contactlessCandidates: 0, reusedReqs: 0, oddMoney: 0 };
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

function addClient(name, department, industry, extra = {}) {
  const raw = clean(name);
  const k = nkey(raw);
  if (!k) return null;
  const hit = clients.get(k);
  if (hit) {
    hit.name = preferred(hit.name, raw);
    Object.entries(extra).forEach(([f, v]) => { if (v && !hit.extra[f]) hit.extra[f] = v; });
    return hit.name;
  }
  clients.set(k, { name: raw, department, industry, extra: { ...extra } });
  return raw;
}
function addSpec(department, name) {
  const raw = clean(name);
  if (!raw || raw.length > 60) return '';
  const k = `${department}|${nkey(raw)}`;
  const hit = specs.get(k);
  if (hit) { hit.name = preferred(hit.name, raw); return hit.name; }
  specs.set(k, { department, name: raw });
  return raw;
}
function addPerson(name, department, designation) {
  const raw = tidyName(name);
  const k = nkey(raw);
  if (!k || k.length < 3) return null;
  const hit = people.get(k);
  if (hit) { hit.name = preferred(hit.name, raw); if (designation === 'TL') hit.designation = 'TL'; return hit.name; }
  people.set(k, { name: raw, department, designation });
  return raw;
}
const reqKeyOf = (dept, client, title, spec) => [dept, nkey(client), nkey(title), nkey(spec)].join('|');

function addRequirement({ department, client, title, specialisation = '', status = 'OPEN', education = '', location = '', description = '', recruiter = '' }) {
  const t = clean(title); const c = clean(client);
  if (!t || !c) return null;
  const key = reqKeyOf(department, c, t, specialisation);
  const already = existingReqs.get(key);
  if (already) {
    if (!reqs.has(key)) { stats.reusedReqs += 1; reqs.set(key, { existingCode: already, key }); }
    return key;
  }
  const hit = reqs.get(key);
  if (hit) {
    if (!hit.education && education) hit.education = education;
    if (!hit.location && location) hit.location = location;
    if (!hit.recruiter && recruiter) hit.recruiter = recruiter;
    return key;
  }
  reqs.set(key, { key, department, client: c, title: t, specialisation, status, education, location, description, recruiter });
  return key;
}

function addCandidate({ name, phone, email, department, specialisation = '', education = '', experience = '', currentDesignation = '', ccdc = '', ectc = '', notice = '', location = '', preferred: pref = '', source = '', ctx = '' }) {
  const nm = tidyName(name);
  const ph = firstPhone(phone);
  const em = clean(email).toLowerCase();
  // A KEY FROM WHATEVER THE SHEET ACTUALLY RECORDS.
  //
  // Email, then phone — and where the sheet has neither (the education
  // profile screening, the medical schedule and interview sheets and the
  // manufacturing ones all record a name and no contact at all) a REFERENCE
  // built from the fields it does carry: name, qualification, branch,
  // experience, present location and the client they were seen for.
  //
  // Keyed on the name alone, two different people called Priyanka would
  // become one person. Refused outright, 12,033 rows of real interview
  // history are thrown away. Six fields agreeing is a far better bet than
  // either, and because the reference is DERIVED rather than random, the
  // same row re-imported produces the same key and updates rather than
  // duplicating.
  let key = em && em.includes("@") ? `e:${em}` : (ph ? `p:${ph}` : "");
  let ref = null;
  if (!key && nm) {
    const parts = [nm, education, specialisation, experience, location, ctx].map((x) => nkey(x)).join("|");
    ref = `R${crypto.createHash("sha1").update(parts).digest("hex").slice(0, 14)}`;
    key = `ref:${ref}`;
    stats.contactlessCandidates += 1;
  }
  if (!key || !nm) { stats.noKeyCandidates += 1; return null; }
  const row = cands.get(key) || { key, name: nm, phone: ph, email: em.includes('@') ? em : '', department, externalRef: ref };
  row.name = preferred(row.name, nm);
  if (!row.phone && ph) row.phone = ph;
  if (!row.email && em.includes('@')) row.email = em;
  Object.entries({ specialisation, education, experience, currentDesignation, ccdc, ectc, notice, location, pref, source })
    .forEach(([f, v]) => { if (v && !row[f]) row[f] = v; });
  cands.set(key, row);
  return key;
}

const RANK = ['NEW', 'RECRUITER_REVIEW', 'SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD', 'SELECTED', 'OFFER_ACCEPTED', 'JOINED', 'REJECTED'];
function addApplication(candKey, reqKey, { statusText, interviewDate = '', mode = '', remarks = '', source = '', offeredCtc = null, joiningDate = '' }) {
  if (!candKey || !reqKey) return;
  const k = `${candKey}|${reqKey}`;
  const mapped = mapStatus(statusText);
  if (statusText && !mapped) bump(stats.unknownStatus, clean(statusText).slice(0, 60));
  const row = apps.get(k) || { candKey, reqKey };
  const next = mapped ? mapped.stage : (row.stage || 'NEW');
  if (!row.stage || RANK.indexOf(next) > RANK.indexOf(row.stage)) {
    row.stage = next;
    if (mapped && mapped.reason) row.reason = mapped.reason;
    if (mapped && mapped.offerStatus) row.offerStatus = mapped.offerStatus;
  }
  if (interviewDate && !row.interviewDate) row.interviewDate = interviewDate;
  if (mode && !row.mode) row.mode = mode;
  if (offeredCtc && !row.offeredCtc) row.offeredCtc = offeredCtc;
  if (joiningDate && !row.joiningDate) row.joiningDate = joiningDate;
  if (remarks) row.remarks = row.remarks ? `${row.remarks}\n${remarks}` : remarks;
  if (source && !row.source) row.source = source;
  apps.set(k, row);
}
const MODE_MAP = { online: 'Online', offline: 'In Person', telephonic: 'Telephonic', conferencecall: 'Telephonic' };

// ===========================================================================
(async () => {
  (await prisma.requirement.findMany({
    select: { reqCode: true, title: true, department: true, specialisation: true, client: { select: { name: true } } },
  })).forEach((r) => {
    existingReqs.set(reqKeyOf(r.department || '', r.client.name, r.title, r.specialisation || ''), r.reqCode);
    if (r.reqCode) takenCodes.add(r.reqCode.toUpperCase());
  });
  (await prisma.client.findMany({ select: { name: true } })).forEach((c) => {
    clients.set(nkey(c.name), { name: c.name, department: null, industry: null, extra: {}, existing: true });
  });
  (await prisma.candidate.findMany({ select: { email: true, phone: true } })).forEach((c) => {
    if (c.email) existingCands.add(`e:${c.email.toLowerCase()}`);
    if (c.phone) existingCands.add(`p:${firstPhone(c.phone)}`);
  });
  (await prisma.invoice.findMany({ select: { invoiceNumber: true } })).forEach((i) => {
    if (i.invoiceNumber) takenInvoices.add(i.invoiceNumber.toUpperCase());
  });
  console.log(`read ${existingReqs.size} requirements, ${clients.size} clients, ${existingCands.size} candidate keys (read-only)\n`);

  const open = async (f) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(DIR + f); return wb; };
  const note = (file, sheet, rows, what) => stats.sources.push({ file, sheet, rows, what });

  // =====================================================================
  // 1. INVOICES
  // =====================================================================
  {
    const wb = await open('Invoice 2026 (1).xlsx');
    const ws = wb.getWorksheet('2026');
    const ix = headerIndex(ws);
    const C = {
      cand: col(ix, 'Candidate Name'), phone: col(ix, 'Contact number'),
      qual: col(ix, 'Qualification'), branch: col(ix, 'Branch'),
      college: col(ix, 'College Name'), offered: col(ix, 'Offered Salary'),
      joining: col(ix, 'Joining date'), num: col(ix, 'Invoice Number'),
      recvNum: col(ix, 'recive invoice no'), date: col(ix, 'Invoice date'),
      rate: col(ix, 'Rate'), tds: col(ix, 'TDS(10%)'),
      cgst: col(ix, 'CGST(9%)'), sgst: col(ix, 'SGST(9%)'),
      amount: col(ix, 'Invoice Amount'), status: col(ix, 'Invoice Pending or REceived'),
      paidDate: col(ix, 'Payment Received date'), received: col(ix, 'Received Payment'),
      pending: col(ix, 'Pending payment'), remarks: col(ix, 'Remarks'),
    };
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const num = cellOf(ws, r, C.num);
      const college = cellOf(ws, r, C.college);
      if (!num || !college) continue;
      const client = addClient(college, 'Education', 'Education');
      const rate = money(cellOf(ws, r, C.rate));
      if (!rate) continue; // an invoice with no fee is not an invoice
      const cgst = money(cellOf(ws, r, C.cgst)) || 0;
      const sgst = money(cellOf(ws, r, C.sgst)) || 0;
      const tds = money(cellOf(ws, r, C.tds)) || 0;

      // THE PERCENTAGES COME FROM WHAT WAS ACTUALLY CHARGED. The column
      // headings say 9%, 9% and 10%, but the rows do not all follow them —
      // some carry 18% GST and no TDS, others 10% TDS and no GST. Writing the
      // heading's figure instead of the row's would restate the books.
      const gstPercent = Math.round(((cgst + sgst) / rate) * 10000) / 100;
      const tdsPercent = Math.round((tds / rate) * 10000) / 100;

      const candPhone = firstPhone(cellOf(ws, r, C.phone));
      const candName = cellOf(ws, r, C.cand);
      let candKey = null;
      if (candName && candPhone) {
        candKey = addCandidate({
          name: candName, phone: candPhone, department: 'Education',
          education: cellOf(ws, r, C.qual), specialisation: addSpec('Education', cellOf(ws, r, C.branch)),
          source: 'Invoice sheet',
        });
      }

      const received = money(cellOf(ws, r, C.received)) || 0;
      const statusRaw = nkey(cellOf(ws, r, C.status));
      const status = statusRaw.includes('receiv') ? (received > 0 ? 'Paid' : 'Pending')
        : statusRaw.includes('pend') ? 'Pending' : (received > 0 ? 'Partially Paid' : 'Pending');

      // A REPEATED INVOICE NUMBER GETS A SUFFIX, and the suffix COUNTS UP.
      // Written as `${num}-A` in a while loop it recomputed the same string
      // every pass and spun forever the first time two rows shared a number —
      // which this sheet does. The counter is what makes the loop terminate.
      let invNum = num;
      let suffix = 0;
      while (takenInvoices.has(invNum.toUpperCase()) || invoices.has(nkey(invNum))) {
        suffix += 1;
        invNum = `${num}-${suffix}`;
        if (suffix > 50) { invNum = `${num}-${Date.now()}`; break; }
      }
      takenInvoices.add(invNum.toUpperCase());

      invoices.set(nkey(invNum), {
        number: invNum,
        client,
        candKey,
        date: asDate(cellOf(ws, r, C.date)) || asDate(cellOf(ws, r, C.joining)),
        amount: rate,
        gstPercent: gstPercent > 0 ? gstPercent : null,
        tdsPercent: tdsPercent > 0 ? tdsPercent : null,
        status,
        received,
        paidDate: asDate(cellOf(ws, r, C.paidDate)),
        offeredCtc: money(cellOf(ws, r, C.offered)),
        joiningDate: asDate(cellOf(ws, r, C.joining)),
        notes: [
          cellOf(ws, r, C.recvNum) && `Client invoice ref: ${cellOf(ws, r, C.recvNum)}`,
          cellOf(ws, r, C.pending) && `Pending as recorded: ${cellOf(ws, r, C.pending)}`,
          cellOf(ws, r, C.remarks) && `Remarks: ${cellOf(ws, r, C.remarks)}`,
          `Invoice total as recorded: ${cellOf(ws, r, C.amount) || '—'}`,
        ].filter(Boolean).join('\n'),
      });
      rows += 1;
    }
    note('Invoice 2026', '2026', rows, 'invoices + the candidates they were raised for');
  }

  // =====================================================================
  // 2. A CANDIDATE / INTERVIEW SHEET, in the shape these four files share
  // =====================================================================
  const candidateSheet = (ws, department, label, file, spec) => {
    const ix = headerIndex(ws);
    const C = {
      cand: col(ix, ...spec.cand), phone: col(ix, ...(spec.phone || ['Contact Number'])),
      client: col(ix, ...spec.client), qual: col(ix, 'Qualification'),
      branch: col(ix, ...(spec.branch || ['Branch', 'Specialization'])),
      desig: col(ix, 'Designation'), exp: col(ix, 'Experience'),
      ctc: col(ix, 'Current CTC', 'Present Salary'), ectc: col(ix, 'Expected CTC', 'Expected Salary'),
      loc: col(ix, 'Current Location', 'Current location', 'Present Location'),
      pref: col(ix, 'Preferred Location'), notice: col(ix, 'Notce Period', 'Notice Period', 'Notice period'),
      req: col(ix, 'Requirement', 'Position'), idate: col(ix, 'Interview Date'),
      istatus: col(ix, 'Interviews Status', 'Interview Status'),
      mode: col(ix, 'Interview Mode'), offered: col(ix, 'Offered CTC'),
      rec: col(ix, 'Recruiter Name'),
      s1: col(ix, 'Status-1', 'Status - 1', 'Status -1'),
      s2: col(ix, 'Status-2', 'Status - 2', 'Status -2'),
      s3: col(ix, 'Status -3', 'Status-3'), reason: col(ix, 'Reasons', 'Reason'),
      rounds: col(ix, 'Rounds'),
    };
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const name = cellOf(ws, r, C.cand);
      if (!name) continue;
      const clientName = cellOf(ws, r, C.client) || spec.defaultClient;
      if (!clientName) continue;
      const client = addClient(clientName, department, spec.industry);
      const branch = addSpec(department, cellOf(ws, r, C.branch));
      const recruiter = addPerson(cellOf(ws, r, C.rec), department, 'Employee');
      const title = cellOf(ws, r, C.req) || cellOf(ws, r, C.desig) || spec.defaultTitle;
      const reqKey = addRequirement({
        department, client, title, specialisation: branch, status: 'OPEN',
        education: cellOf(ws, r, C.qual), recruiter: recruiter || '',
        description: `Created from the "${label}" sheet, which recorded candidates against this post.`,
      });
      const candKey = addCandidate({
        name, phone: cellOf(ws, r, C.phone), department,
        specialisation: branch, education: cellOf(ws, r, C.qual),
        experience: cellOf(ws, r, C.exp), currentDesignation: cellOf(ws, r, C.desig),
        ccdc: cellOf(ws, r, C.ctc), ectc: cellOf(ws, r, C.ectc),
        notice: cellOf(ws, r, C.notice), location: cellOf(ws, r, C.loc),
        preferred: cellOf(ws, r, C.pref), source: spec.source, ctx: client,
      });
      // THE FURTHEST STATUS ON THE ROW WINS, so the columns are read from the
      // end of the process backwards.
      const statusText = cellOf(ws, r, C.s3) || cellOf(ws, r, C.s2)
        || cellOf(ws, r, C.istatus) || cellOf(ws, r, C.s1);
      addApplication(candKey, reqKey, {
        statusText,
        interviewDate: asDate(cellOf(ws, r, C.idate)),
        mode: MODE_MAP[nkey(cellOf(ws, r, C.mode))] || '',
        offeredCtc: money(cellOf(ws, r, C.offered)),
        remarks: [
          cellOf(ws, r, C.s1) && `Status-1: ${cellOf(ws, r, C.s1)}`,
          cellOf(ws, r, C.s2) && `Status-2: ${cellOf(ws, r, C.s2)}`,
          cellOf(ws, r, C.s3) && `Status-3: ${cellOf(ws, r, C.s3)}`,
          cellOf(ws, r, C.rounds) && `Rounds: ${cellOf(ws, r, C.rounds)}`,
          cellOf(ws, r, C.reason) && `Reason: ${cellOf(ws, r, C.reason)}`,
        ].filter(Boolean).join('\n'),
        source: spec.source,
      });
      rows += 1;
    }
    note(file, label, rows, `${department} candidates + applications`);
  };

  // --- education profile screening ---------------------------------------
  {
    const wb = await open('BDE-Edu-Profile Screening -Sheet.xlsx');
    candidateSheet(wb.getWorksheet('ProfileScreening'), 'Education', 'ProfileScreening', 'BDE-Edu-Profile Screening', {
      cand: ['Candidate Name'], client: ['College name', 'College Name'],
      industry: 'Education', defaultTitle: 'Faculty', source: 'Profile screening',
    });
    candidateSheet(wb.getWorksheet('Presidency University Profiles'), 'Education', 'Presidency University Profiles', 'BDE-Edu-Profile Screening', {
      cand: ['Candidate Name'], client: ['College Name'],
      industry: 'Education', defaultTitle: 'Faculty', source: 'Profile screening',
    });
    // Two activity logs. Neither carries a candidate, so neither can become a
    // record without inventing one.
    stats.skipped.push('BDE-Edu / "Interview Pending Names" (2,760 rows) — a DAILY LOG of interview confirmations per college: date, how many resumes, what was said on the call. No candidate name anywhere, so there is nobody to file it against. It is follow-up activity, and the right home for it is a client follow-up log rather than a candidate.');
    stats.skipped.push('BDE-Edu / "No Profiles" (132 rows) — a list of dates a college had no profiles to send. Activity, not records.');
    stats.skipped.push('BDE-Edu / "Sheet9" — empty');
  }

  // --- medical worksheet --------------------------------------------------
  {
    const wb = await open('BDE MED Worksheet.xlsx');
    candidateSheet(wb.getWorksheet('Schedule Sheet'), 'Medical', 'Schedule Sheet', 'BDE MED Worksheet', {
      cand: ['Name'], client: ['Client Name'], branch: ['Specialization'],
      industry: 'Healthcare', defaultTitle: 'Medical Requirement', source: 'BDE medical desk',
    });
    candidateSheet(wb.getWorksheet('Interview Sheet'), 'Medical', 'Interview Sheet', 'BDE MED Worksheet', {
      cand: ['Name'], client: ['Client Name'], branch: ['Specialization'],
      industry: 'Healthcare', defaultTitle: 'Medical Requirement', source: 'BDE medical desk',
    });
    const cp = wb.getWorksheet('Care Point Polyclinic & Diagnos');
    if (cp) {
      candidateSheet(cp, 'Medical', 'Care Point Polyclinic', 'BDE MED Worksheet', {
        cand: ['Candidate Name'], client: ['__none__'], branch: ['__none__'],
        defaultClient: 'Care Point Polyclinic & Diagnostics',
        industry: 'Healthcare', defaultTitle: 'Medical Requirement', source: 'BDE calling',
      });
    }

    // CLIENT COMMERCIAL TERMS — the fee, the agreement date and who to call.
    const fu = wb.getWorksheet('Client Follow Up Sheet');
    if (fu) {
      const ix = headerIndex(fu);
      const C = {
        name: col(ix, 'F') || 1, beds: col(ix, 'Bed capacaity', 'Bed capacity'),
        loc: col(ix, 'Location'), charges: col(ix, 'Charges'),
        agreed: col(ix, 'Agreeement Date', 'Agreement Date'),
        person: col(ix, 'Contact Person'), phone: col(ix, 'Contact Number'),
        desig: col(ix, 'Designation'), mail: col(ix, 'Mail.ID', 'Mail ID'),
        profiles: col(ix, 'No.Of Profiles'), remarks: col(ix, 'Remarks'),
      };
      let rows = 0;
      for (let r = 2; r <= fu.rowCount; r += 1) {
        const name = cellOf(fu, r, C.name);
        if (!name) continue;
        const mail = cellOf(fu, r, C.mail);
        addClient(name, 'Medical', 'Healthcare', {
          contactName: cellOf(fu, r, C.person),
          contactPhone: firstPhone(cellOf(fu, r, C.phone)),
          contactEmail: mail.includes('@') ? mail.split(/\s+/).find((x) => x.includes('@')) : '',
          contactDesignation: cellOf(fu, r, C.desig),
          street: cellOf(fu, r, C.loc),
          commercialNotes: [
            cellOf(fu, r, C.charges) && `Charges: ${cellOf(fu, r, C.charges)}`,
            cellOf(fu, r, C.agreed) && `Agreement date: ${asDate(cellOf(fu, r, C.agreed)) || cellOf(fu, r, C.agreed)}`,
            cellOf(fu, r, C.beds) && `Bed capacity: ${cellOf(fu, r, C.beds)}`,
            cellOf(fu, r, C.profiles) && `Profile history: ${cellOf(fu, r, C.profiles)}`,
            cellOf(fu, r, C.remarks) && `Remarks: ${cellOf(fu, r, C.remarks)}`,
          ].filter(Boolean).join('\n'),
        });
        rows += 1;
      }
      note('BDE MED Worksheet', 'Client Follow Up Sheet', rows, 'client commercial terms + contacts');
    }
    stats.skipped.push('BDE MED / "Promotion Data" — job-portal search totals (portal, data count, response count). Activity, not records.');
  }

  // --- manufacturing ------------------------------------------------------
  {
    const wb = await open('Manufacture Client Follow Up   (1).xlsx');
    candidateSheet(wb.getWorksheet('Schedule Sheet'), 'Manufacturing', 'Schedule Sheet', 'Manufacture Client Follow Up', {
      cand: ['Name'], client: ['Client Name'], branch: ['Branch'],
      industry: 'Manufacturing', defaultTitle: 'Manufacturing Requirement', source: 'BDE manufacturing desk',
    });
    candidateSheet(wb.getWorksheet('Interview sheet'), 'Manufacturing', 'Interview sheet', 'Manufacture Client Follow Up', {
      cand: ['Name'], client: ['Client Name'], branch: ['Branch'],
      industry: 'Manufacturing', defaultTitle: 'Manufacturing Requirement', source: 'BDE manufacturing desk',
    });
  }

  // =====================================================================
  // WRITE
  // =====================================================================
  // Resolve every name once more, now all sheets are read — the same reason
  // batch 2 does it: addSpec/addClient return the best spelling known at the
  // time, and a later row can improve it.
  reqs.forEach((r) => {
    if (r.existingCode) return;
    if (r.specialisation) {
      const s = specs.get(`${r.department}|${nkey(r.specialisation)}`);
      if (s) r.specialisation = s.name;
    }
    const c = clients.get(nkey(r.client));
    if (c) r.client = c.name;
  });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await buildTemplate()));
  const put = (sheetName, rows) => {
    const ws = wb.getWorksheet(sheetName);
    const ix = {};
    ws.getRow(1).eachCell((c, n) => { ix[clean(c.value)] = n; });
    rows.forEach((row, i) => {
      Object.entries(row).forEach(([h, v]) => {
        if (v === null || v === undefined || v === '') return;
        const at = ix[h];
        if (!at) throw new Error(`template sheet ${sheetName} has no column "${h}"`);
        ws.getRow(i + 2).getCell(at).value = v;
      });
    });
    return rows.length;
  };

  const DEPTS = ['Education', 'Medical', 'Manufacturing'];
  put('Departments', DEPTS.map((d) => ({ Department: d, Team: `${d} Team-A` })));
  put('Specialisations', [...specs.values()].map((s) => ({ Department: s.department, Specialisation: s.name })));

  let pn = 0;
  put('Employees', [...people.values()].map((p) => {
    pn += 1;
    return {
      'Employee Code': `B3-${String(pn).padStart(4, '0')}`,
      'Full Name': p.name, Department: p.department, Team: `${p.department} Team-A`,
      Designation: p.designation === 'TL' ? 'TL' : 'Employee',
      'Employment Status': 'Active', 'Create Login': 'No',
    };
  }));

  put('Clients', [...clients.values()].filter((c) => !c.existing || Object.keys(c.extra).length).map((c) => ({
    'Client Name': c.name,
    Industry: c.industry || '',
    Status: 'Active',
    'Owning Department': c.department || '',
    'Client Type': 'Direct',
    'Primary Contact Name': c.extra.contactName || '',
    'Primary Contact Designation': c.extra.contactDesignation || '',
    'Primary Contact Phone': c.extra.contactPhone || '',
    'Primary Contact Email': c.extra.contactEmail || '',
    Address: c.extra.street || '',
    'Commercial Notes': c.extra.commercialNotes || '',
  })));

  const PREFIX = { Education: ['EDU', 2000], Medical: ['MED', 2000], Manufacturing: ['MFG', 2000] };
  const counters = {};
  const codeFor = new Map();
  const reqRows = [];
  [...reqs.values()].forEach((r) => {
    if (r.existingCode) { codeFor.set(r.key, r.existingCode); return; }
    const [p, base] = PREFIX[r.department] || ['REQ', 2000];
    let code;
    do {
      counters[p] = (counters[p] || base) + 1;
      code = `${p}-${String(counters[p]).padStart(4, '0')}`;
    } while (takenCodes.has(code));
    takenCodes.add(code);
    codeFor.set(r.key, code);
    reqRows.push({
      'Requirement Code': code,
      'Job Title': r.title.slice(0, 200),
      'Client Name': r.client,
      Department: r.department,
      Specialisation: r.specialisation || '',
      Status: r.status,
      Education: r.education || '',
      Location: r.location || '',
      'Assigned Recruiter': r.recruiter || '',
      'Job Description': r.description || '',
      'Hiring Type': 'Client Placement',
    });
  });
  put('Requirements', reqRows);

  put('Candidates', [...cands.values()].map((c) => ({
    'Full Name': c.name, Email: c.email || '', Phone: c.phone || '',
    'Current Location': c.location || '', 'Preferred Location': c.pref || '',
    'Current Designation': c.currentDesignation || '',
    'Current Salary': c.ccdc || '', 'Expected Salary': c.ectc || '',
    'Notice Period': c.notice || '', Education: c.education || '',
    Specialisation: c.specialisation || '', Source: c.source || '',
    'External Ref': c.externalRef || '',
  })));

  const appRows = [];
  apps.forEach((a) => {
    const cand = cands.get(a.candKey);
    const code = codeFor.get(a.reqKey);
    if (!cand || !code) return;
    appRows.push({
      'Candidate Email or Phone': cand.email || cand.phone || cand.externalRef,
      'Requirement Code': code,
      Stage: a.stage || 'NEW',
      'Interview Date/Time': a.interviewDate || '',
      'Interview Mode': a.mode || '',
      'Offer Status': a.offerStatus || '',
      'Offered CTC': a.offeredCtc || '',
      'Joining Date': a.joiningDate || '',
      'Rejection Reason': a.stage === 'REJECTED' ? (a.reason || 'Recorded as rejected on the source sheet') : '',
      Source: a.source || '',
      'Interview Feedback': (a.remarks || '').slice(0, 1800),
    });
  });
  put('Applications', appRows);

  const invRows = [];
  invoices.forEach((i) => {
    const cand = i.candKey ? cands.get(i.candKey) : null;
    invRows.push({
      'Invoice Number': i.number,
      'Client Name': i.client,
      'Candidate Email or Phone': cand ? (cand.email || cand.phone || cand.externalRef) : '',
      'Invoice Date': i.date,
      Amount: i.amount,
      'GST %': i.gstPercent,
      'TDS %': i.tdsPercent,
      Status: i.status,
      'Received Amount': i.received,
      'Paid Date': i.paidDate,
      'Offered CTC': i.offeredCtc,
      'Joining Date': i.joiningDate,
      Notes: i.notes,
    });
  });
  put('Invoices', invRows);

  fs.writeFileSync(OUT, Buffer.from(await wb.xlsx.writeBuffer()));

  // --- report -------------------------------------------------------------
  console.log(`Wrote ${OUT}\n`);
  console.log('READ FROM:');
  stats.sources.forEach((s) => console.log(`  ${s.file.padEnd(30)} ${s.sheet.padEnd(32)} ${String(s.rows).padStart(6)} rows -> ${s.what}`));
  console.log('\nPRODUCED:');
  console.log(`  ${specs.size} specialisations`);
  console.log(`  ${people.size} people (no logins)`);
  console.log(`  ${[...clients.values()].filter((c) => !c.existing).length} new clients, ${[...clients.values()].filter((c) => c.existing && Object.keys(c.extra).length).length} existing clients enriched`);
  console.log(`  ${reqRows.length} new requirements (${stats.reusedReqs} reused by content)`);
  console.log(`  ${cands.size} candidates (${[...cands.keys()].filter((k) => existingCands.has(k)).length} already in the system)`);
  console.log(`  ${appRows.length} applications`);
  console.log(`  ${invRows.length} invoices`);
  const money0 = invRows.reduce((n, i) => n + (i.Amount || 0), 0);
  const recv = invRows.reduce((n, i) => n + (i['Received Amount'] || 0), 0);
  console.log(`      invoiced ₹${money0.toLocaleString('en-IN')}, received ₹${recv.toLocaleString('en-IN')}`);
  const byStage = {};
  appRows.forEach((a) => { byStage[a.Stage] = (byStage[a.Stage] || 0) + 1; });
  console.log('\n  applications by stage:');
  Object.entries(byStage).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`      ${String(n).padStart(6)}  ${s}`));
  console.log('\nJUDGEMENTS AND GAPS:');
  console.log(`  ${stats.contactlessCandidates} candidate rows had NO contact details at all — those sheets have no phone or email column. They are keyed on name + qualification + branch + experience + location + client, so the same row re-imports as the same person.`);
  console.log(`  ${stats.noKeyCandidates} candidate rows had no name either — not imported, there is nothing to identify them by`);
  if (stats.unknownStatus.size) {
    console.log(`  ${stats.unknownStatus.size} status phrases not recognised:`);
    [...stats.unknownStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([k, n]) => console.log(`      ${String(n).padStart(5)} x "${k}"`));
  }
  console.log('\nNOT IMPORTED:');
  stats.skipped.forEach((s) => console.log(`  • ${s}`));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
