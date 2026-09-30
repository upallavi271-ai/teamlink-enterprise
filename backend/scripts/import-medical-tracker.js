// ---------------------------------------------------------------------------
// IMPORT: Medical recruitment tracker (1 Oct 2025 – 24 Sep 2026).
//
//   node scripts/import-medical-tracker.js <file.xlsx>            dry run
//   node scripts/import-medical-tracker.js <file.xlsx> --commit   write
//
// One row = one candidate put forward for one client role by one recruiter,
// in one Medical seat (Med 1 … Med 5, TL), under one TL, on one date.
//
// WHAT IT DOES — add and update, NEVER delete candidates or requirements:
//   people     the confirmed name → employee matches below; each person's
//              department becomes Medical, TLs get the TL designation, and
//              today's recruiters report to today's TL
//   seats      MED-1…MED-5 and MED-TL get their real holder history from the
//              dates in the file (a lone row inside someone else's run is
//              treated as a slip, not a handover)
//   clients    matched by name (exact, then the name before the comma, then
//              the closest by city); unmatched ones are created as Medical
//   requirements  one per client + designation (+ specialisation); an
//              existing Medical requirement with the same client and title
//              is reused
//   candidates matched by the last 10 digits of the phone; created
//              otherwise; an existing candidate only has BLANK fields filled
//   applications  one per candidate + requirement, at the stage the row's
//              status columns describe; rejections carry the side (Client /
//              Candidate) and a reason from the Reject dialog's own lists
//   follow-up  one COMPLETED follow-up per application holding the recruiter,
//              TL and seat of that row plus every status/remark column — the
//              Candidates screen reads recruiter / TL / position from it
//
// Idempotent: re-running updates what it created instead of doubling it.
// ---------------------------------------------------------------------------
const path = require('path');

process.chdir(path.join(__dirname, '..'));
const XLSX = require('xlsx');
const prisma = require('../src/db');

const FILE = process.argv[2];
const COMMIT = process.argv.includes('--commit');
const TODAY = '2026-09-24';
const IMPORTER = 'Imported — Medical tracker';
const SOURCE = 'Medical recruitment tracker';

// Confirmed with the user. TL "Renuka" (Nov-25 → Mar-26) and recruiter
// "Renuka" (Med 2, Apr-26 →) are two different people.
const PEOPLE = {
  keerthana: 'TL460', sasi: 'TL330', sannidhi: 'TL423', veneesha: 'TL409', ragini: 'TL416',
  yamuna: 'TL443', maneesha: 'TL481', kaveri: 'TL436', 'bhanu teja': 'TL474', sathvik: 'TL455',
  niveditha: 'TL424', akhila: 'TL468', sravanthi: 'TL506', mounika: 'TL493',
};
const RENUKA_AS_TL = 'TL382';
const RENUKA_AS_RECRUITER = 'TL482';

const t = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const lc = (v) => t(v).toLowerCase();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// "01-Oct-25", "13-10-2025", "20-2-26", "25/05/2026", "16--03-26", "jan 5th,2026"
function isoDate(v) {
  const s = lc(v);
  if (!s) return null;
  let m = s.match(/(\d{1,2})\s*[-/.]+\s*([a-z]{3,})\s*[-/.]+\s*(\d{2,4})/);
  if (m && MONTHS[m[2].slice(0, 3)]) return ymd(m[3], MONTHS[m[2].slice(0, 3)], m[1]);
  m = s.match(/(\d{1,2})\s*[-/.]+\s*(\d{1,2})\s*[-/.]+\s*(\d{2,4})/);
  if (m) return ymd(m[3], m[2], m[1]);
  m = s.match(/([a-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3)]) return ymd(m[3], MONTHS[m[1].slice(0, 3)], m[2]);
  return null;
}
function ymd(y, mo, d) {
  let year = Number(y);
  if (year < 100) year += 2000;
  const month = Number(mo);
  const day = Number(d);
  if (year < 2020 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function seatOf(v) {
  const s = lc(v);
  if (s === 'tl') return 'MED-TL';
  const m = s.match(/med\W*0?(\d)/);
  return m ? `MED-${m[1]}` : null;
}

// Offered CTC → ANNUAL rupees, only when the text is unambiguous. The sheet
// mixes "1.2LPM", "90k per month", "17000" and sentences; anything unclear
// stays as text in offerNotes.
function annualCtc(v) {
  const s = lc(v).replace(/,/g, '');
  if (!s || /[a-z]{4,}/.test(s.replace(/lpm|lpa|per month|pm|gross|k/g, ''))) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*lpm$/);
  if (m) return Math.round(Number(m[1]) * 100000 * 12);
  m = s.match(/^(\d+(?:\.\d+)?)\s*lpa$/);
  if (m) return Math.round(Number(m[1]) * 100000);
  m = s.match(/^(\d+(?:\.\d+)?)\s*k\s*(?:per month|pm|gross)?$/);
  if (m) return Math.round(Number(m[1]) * 1000 * 12);
  m = s.match(/^(\d{4,7})$/);
  if (m) return Math.round(Number(m[1]) * 12); // a plain monthly figure
  return null;
}

const years = (v) => { const m = lc(v).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const titleCase = (s) => t(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
// Client names: the tracker spells the same branch several ways ("Vacare",
// "V care", "Clininc", "Hydrabad"), so spellings are corrected before any
// comparison and the words that carry no identity are dropped.
const SPELLING = [
  [/\bv\s*a?\s*care\b/g, 'vcare'], [/\bclinin?c\b/g, 'clinic'], [/\bhydrabad\b|\bhyd\b/g, 'hyderabad'],
  [/\bkukatpallu\b/g, 'kukatpally'], [/\bcollage\b/g, 'college'], [/\bbanglore\b/g, 'bangalore'],
  [/\bsrikalahsthi\b|\bsrikalshathi\b/g, 'srikalahasthi'], [/\bbanjarhills\b|\bbanjara hills\b/g, 'banjarahills'],
  [/\bmanglore\b/g, 'mangalore'], [/\bvijawada\b/g, 'vijayawada'], [/\bbelagum\b/g, 'belgaum'],
  [/\bkarantaka\b/g, 'karnataka'], [/\btelengana\b/g, 'telangana'], [/\banatara\b/g, 'antara'],
  [/\bassociated\b/g, 'assisted'], [/\bservice\b/g, 'services'], [/\bhospitals\b/g, 'hospital'],
];
// Words that say nothing about WHICH branch it is: legal suffixes, "health",
// "clinic", the role ("MBBS"), the home city, full/part time.
const DROP = /\b(pvt|private|ltd|limited|llp|the|and|health|care|hospitals?|clinic|mbbs|india|telangana|hyderabad|full ?time|part ?time|time|full|part)\b/g;
function normName(s) {
  let x = lc(s).replace(/[^a-z0-9 ]+/g, ' ');
  SPELLING.forEach(([re, to]) => { x = x.replace(re, to); });
  return x.replace(DROP, ' ').replace(/\s+/g, ' ').trim();
}
const tokens = (s) => new Set(normName(s).split(' ').filter(Boolean));
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (new Set([...A, ...B]).size || 1);
}

// The sheet is in date order; a date far behind both neighbours is a typo in
// the month (rows dated 22-03-26 sitting between 15-06 and 23-06 are 22-06).
// It is moved into the neighbours' month, and every repair is reported.
function repairDates(rows) {
  const fixes = [];
  const gap = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400000;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows.slice(0, i).reverse().find((r) => r.date);
    const r = rows[i];
    if (!r.date || !prev) continue;
    // The next row that is NOT itself far behind (typos come in runs).
    const next = rows.slice(i + 1).find((x) => x.date && gap(prev.date, x.date) <= 25);
    const behind = gap(prev.date, r.date);
    if (behind > 25 && (!next || next.date >= prev.date)) {
      const fixed = `${prev.date.slice(0, 7)}-${r.date.slice(8, 10)}`;
      const candidate = fixed >= prev.date ? fixed : (next ? `${next.date.slice(0, 7)}-${r.date.slice(8, 10)}` : fixed);
      fixes.push(`row ${r.line}: ${r.date} → ${candidate}`);
      r.date = candidate;
    }
  }
  return fixes;
}

// ---- the stage a row describes ---------------------------------------------
const CANDIDATE_SIDE = [
  [/did ?n.?t join|not join|wont join|won.?t join|not joining/, 'Did Not Join'],
  [/dropp/, 'Offer Declined'],
  [/not ok with (the )?package|less salary|expect|need \d|not accept|salary/, 'Salary Expectation'],
  [/location|far|relocat|accomodation|accommodation|shift from/, 'Location / Relocation'],
  [/got (a job )?in other|another|other hospital|selected as dm/, 'Accepted Another Offer'],
  [/not interested|not wil+ing|rejected by candidate|candidate (is )?(able|informed|confirmed)|4 days|bond/, 'Not Interested'],
  [/not attended|did not attend|no show/, 'Did Not Attend Interview'],
];
const CLIENT_SIDE = [
  [/communication/, 'Communication'],
  [/fresher|experience|not upto|clinical|basic computer|dnb/, 'Insufficient Experience'],
  [/not shortlisted|profile (is )?rejected|not having/, 'Not Shortlisted'],
];
const classify = (text, table, fallback) => (table.find(([re]) => re.test(text)) || [null, fallback])[1];

function stageOf(r) {
  const sel = lc(r.sel);
  const join = lc(r.join);
  const iv = lc(r.iv);
  const short = lc(r.short);
  const s2 = lc(r.s2);
  const all = [r.sel, r.join, r.iv, r.remarks, r.s1].map(lc).join(' | ');

  if (/^(joined|joinned|completed|joining completed)$/.test(join) || /joining completed/.test(lc(r.remarks))) return { stage: 'JOINED' };
  if (/not join|wont join|won.?t join|^rejected$/.test(join)) {
    return { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Join', detail: t([r.join, r.remarks].filter(Boolean).join(' — ')) };
  }
  if (sel && sel !== '-') {
    if (/^hold/.test(sel)) return { stage: 'HOLD', category: 'Awaiting Client Feedback', detail: t(r.sel) };
    const candidateSide = /candidate|dropp|not ok|expect|not interested|far|accomodation|relocat|not wil+ing|only \d|bond|package|salary/.test(sel);
    if (/select/.test(sel) && !/not select/.test(sel) && !candidateSide) {
      if (/2nd round|second round/.test(sel) && !/far|location/.test(sel)) return { stage: 'INTERVIEW_COMPLETED' };
      return { stage: 'SELECTED' };
    }
    if (candidateSide) return { stage: 'REJECTED', side: 'Candidate', category: classify(all, CANDIDATE_SIDE, 'Other'), detail: t(r.sel) };
    if (/reject|not select/.test(sel)) return { stage: 'REJECTED', side: 'Client', category: classify(all, CLIENT_SIDE, 'Not Selected'), detail: t(r.sel) };
    return { stage: 'REJECTED', side: 'Candidate', category: classify(all, CANDIDATE_SIDE, 'Other'), detail: t(r.sel) };
  }
  if (/interview (is )?completed|interview done|^completed$/.test(iv)) return { stage: 'INTERVIEW_COMPLETED' };
  if (/not attended|did not attend/.test(all)) return { stage: 'REJECTED', side: 'Candidate', category: 'Did Not Attend Interview', detail: t(r.iv || r.remarks) };
  if (/profile (is )?rejected|not shortlisted/.test(all)) return { stage: 'REJECTED', side: 'Client', category: 'Not Shortlisted', detail: t(r.iv || r.s1) };
  if (/^no\b/.test(short)) return { stage: 'REJECTED', side: 'Client', category: 'Not Shortlisted', detail: 'Profile not shortlisted by the client' };
  if (/not interested/.test(s2)) return { stage: 'REJECTED', side: 'Candidate', category: 'Not Interested', detail: t(r.s1 || r.s2) };
  if (/scheduled/.test(short) || /not completed/.test(iv)) return { stage: 'INTERVIEW_SCHEDULED' };
  if (/^yes|shortlisted/.test(short)) return { stage: 'CLIENT_SHORTLISTED' };
  return { stage: 'SHARED_WITH_CLIENT' };
}

const STAGE_ACTION = {
  JOINED: 'Joined', REJECTED: 'Rejected', HOLD: 'Put on hold', SELECTED: 'Selected',
  INTERVIEW_COMPLETED: 'Interview completed', INTERVIEW_SCHEDULED: 'Interview scheduled',
  CLIENT_SHORTLISTED: 'Client shortlisted', SHARED_WITH_CLIENT: 'Shared with client',
};

(async () => {
  if (!FILE) throw new Error('Pass the .xlsx path.');
  const raw = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets.Sheet1, { defval: '', raw: false });
  const rows = raw.map((x, i) => ({
    line: i + 2,
    date: isoDate(x.Date),
    seat: seatOf(x.Position),
    tl: lc(x['TL Name']),
    recruiter: lc(x['Recruiter Name']),
    client: t(x['Client Name']),
    name: t(x['Candidate Name']),
    phone: phone10(x.Contact),
    qualification: t(x.Qualification),
    specialization: t(x.Specialization),
    designation: t(x.Designation),
    experience: t(x.Experience),
    currentCtc: t(x['Current CTC']),
    expectedCtc: t(x['Expecting CTC']),
    location: t(x['Current Location']),
    preferred: t(x['Preferred Location']),
    notice: t(x['Notice period']),
    s1: t(x['Status -1']),
    s2: t(x['Status 2']),
    short: t(x['Profile Short list \nStatus']),
    ivDate: t(x['Intereview Date']),
    iv: t(x['Interviews Status']),
    sel: t(x['Selected or \nRejected']),
    offered: t(x['Offered CTC']),
    join: t(x['Joining Status']),
    joinDate: t(x['Joining Date']),
    remarks: t(x.Remarks),
  }));
  const problems = [];
  const dateFixes = repairDates(rows);
  const report = {
    rows: rows.length, peopleUpdated: 0, seatSegments: 0,
    clients: { matched: 0, created: 0 }, requirements: { reused: 0, created: 0 },
    candidates: { matched: 0, created: 0, filled: 0 }, applications: { created: 0, updated: 0 },
    stages: {}, rejectedBySide: {},
  };

  // ---- people --------------------------------------------------------------
  const codes = [...new Set([...Object.values(PEOPLE), RENUKA_AS_TL, RENUKA_AS_RECRUITER])];
  const employees = await prisma.employee.findMany({
    where: { employeeCode: { in: codes } },
    include: { user: { select: { id: true, status: true } } },
  });
  const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
  codes.forEach((c) => { if (!byCode.has(c)) problems.push(`employee ${c} not found`); });
  const person = (nameLc, role) => {
    if (nameLc === 'renuka') return byCode.get(role === 'TL' ? RENUKA_AS_TL : RENUKA_AS_RECRUITER);
    return byCode.get(PEOPLE[nameLc] || '') || null;
  };
  const activeLogin = (e) => (e && e.user && e.user.status === 'Active' && !['Relieved', 'Exited', 'Exit Process'].includes(e.employmentStatus) ? e.user.id : null);

  rows.forEach((r) => {
    if (!r.date) problems.push(`row ${r.line}: date not readable`);
    if (!r.seat) problems.push(`row ${r.line}: position not readable`);
    if (!person(r.tl, 'TL')) problems.push(`row ${r.line}: TL "${r.tl}" not matched`);
    if (!person(r.recruiter, 'REC')) problems.push(`row ${r.line}: recruiter "${r.recruiter}" not matched`);
    if (!r.phone) problems.push(`row ${r.line}: no 10-digit phone for "${r.name}"`);
  });
  const usable = rows.filter((r) => r.date && r.seat && r.phone && person(r.tl, 'TL') && person(r.recruiter, 'REC'));
  usable.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);

  // ---- seat history --------------------------------------------------------
  const seatCodes = ['MED-1', 'MED-2', 'MED-3', 'MED-4', 'MED-5', 'MED-TL'];
  const positions = await prisma.position.findMany({ where: { code: { in: seatCodes } } });
  const posByCode = new Map(positions.map((p) => [p.code, p]));
  seatCodes.forEach((c) => { if (!posByCode.has(c)) problems.push(`seat ${c} not found`); });
  const history = {};
  for (const code of seatCodes) {
    const seq = code === 'MED-TL'
      ? usable.map((r) => ({ date: r.date, who: person(r.tl, 'TL') }))
      : usable.filter((r) => r.seat === code).map((r) => ({ date: r.date, who: person(r.recruiter, 'REC') }));
    let runs = [];
    seq.forEach((x) => {
      const last = runs[runs.length - 1];
      if (last && last.who.id === x.who.id) { last.to = x.date; last.n += 1; } else runs.push({ who: x.who, from: x.date, to: x.date, n: 1 });
    });
    // A lone row inside somebody else's run is a slip, not a handover.
    runs = runs.filter((run, i) => !(run.n === 1 && runs[i - 1] && runs[i + 1] && runs[i - 1].who.id === runs[i + 1].who.id));
    const merged = [];
    runs.forEach((run) => {
      const last = merged[merged.length - 1];
      if (last && last.who.id === run.who.id) { last.to = run.to; last.n += run.n; } else merged.push({ ...run });
    });
    merged.forEach((run, i) => {
      const next = merged[i + 1];
      if (next) {
        const d = new Date(`${next.from}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        run.until = d.toISOString().slice(0, 10) < run.from ? run.from : d.toISOString().slice(0, 10);
      } else {
        run.until = activeLogin(run.who) || run.who.employmentStatus !== 'Relieved' ? null : run.to;
      }
    });
    history[code] = merged;
  }

  // ---- clients ---------------------------------------------------------------
  // Medical clients first, so a Medical branch wins over an Education one
  // spelled the same way.
  const clients = (await prisma.client.findMany({ select: { id: true, name: true, ownerDepartment: true } }))
    .sort((a, b) => (a.ownerDepartment === 'Medical' ? 0 : 1) - (b.ownerDepartment === 'Medical' ? 0 : 1));
  const exact = new Map();
  clients.forEach((c) => { const k = normName(c.name); if (!exact.has(k)) exact.set(k, c); });
  const clientFor = new Map();
  const clientMatches = [];
  const newClients = [];
  const newByKey = new Map(); // spelling variants of ONE new client become one
  for (const name of [...new Set(usable.map((r) => r.client).filter(Boolean))]) {
    let hit = exact.get(normName(name));
    let how = 'exact';
    if (!hit) {
      // Same words in any order, or nearly all of them, from a client that
      // starts with the same word — "Mamatha Hospital Bachupally Hyderabad"
      // is "Mamatha Hospital, Bachupally, Hyderabad".
      const mine = tokens(name);
      const first = [...mine][0];
      let best = null; let bestScore = 0;
      clients.forEach((c) => {
        const theirs = tokens(c.name);
        if ([...theirs][0] !== first) return;
        // A client carrying EVERY word of this name (its branch included)
        // beats a generic parent that merely shares most of them.
        const sc = jaccard(name, c.name) + ([...mine].every((w) => theirs.has(w)) ? 0.2 : 0);
        if (sc > bestScore) { best = c; bestScore = sc; }
      });
      if (best && bestScore >= 0.75) { hit = best; how = `similar (${bestScore.toFixed(2)})`; }
    }
    if (hit) {
      clientFor.set(name, hit.id);
      report.clients.matched += 1;
      if (how !== 'exact') clientMatches.push(`${name}  →  ${hit.name}  [${how}]`);
      continue;
    }
    const key = [...tokens(name)].sort().join(' ');
    if (newByKey.has(key)) { newByKey.get(key).variants.push(name); continue; }
    const entry = { name, variants: [name] };
    newByKey.set(key, entry);
    newClients.push(entry);
    report.clients.created += 1;
  }

  if (!COMMIT) {
    usable.forEach((r) => { const s = stageOf(r); report.stages[s.stage] = (report.stages[s.stage] || 0) + 1; if (s.side) report.rejectedBySide[s.side] = (report.rejectedBySide[s.side] || 0) + 1; });
    const phones = [...new Set(usable.map((r) => r.phone))];
    for (const ph of phones) {
      const c = await prisma.candidate.findFirst({ where: { phone: { contains: ph } }, select: { id: true } });
      if (c) report.candidates.matched += 1; else report.candidates.created += 1;
    }
    const groups = new Set(usable.map((r) => `${r.client}|${lc(r.designation || r.specialization)}|${lc(r.specialization)}`));
    report.requirementGroups = groups.size;
    console.log(JSON.stringify({
      DRY_RUN: true, report, usableRows: usable.length, problems, dateFixes,
      clientMatches,
      newClients: newClients.map((e) => (e.variants.length > 1 ? `${e.name}  (+ ${e.variants.length - 1} spelling variant(s))` : e.name)),
      seatHistory: Object.fromEntries(Object.entries(history).map(([k, v]) => [k, v.map((x) => `${x.who.name}: ${x.from} → ${x.until || 'now'} (${x.n} rows)`)])),
    }, null, 1));
    await prisma.$disconnect();
    return;
  }

  // =========================== WRITE ===========================================
  // People: department Medical; TL designation for the TLs; today's recruiters
  // report to today's TL.
  const tlCodes = new Set(history['MED-TL'].map((x) => x.who.employeeCode));
  const currentTl = history['MED-TL'].find((x) => !x.until)?.who;
  const currentRecruiters = seatCodes.filter((c) => c !== 'MED-TL').map((c) => history[c].find((x) => !x.until)?.who).filter(Boolean);
  for (const e of new Map([...byCode.values()].map((x) => [x.id, x])).values()) {
    const data = {};
    if (e.department !== 'Medical') data.department = 'Medical';
    const lastTlRun = history['MED-TL'].filter((x) => x.who.id === e.id).pop();
    const lastSeatRun = seatCodes.filter((c) => c !== 'MED-TL').flatMap((c) => history[c]).filter((x) => x.who.id === e.id).sort((a, b) => a.from.localeCompare(b.from)).pop();
    const endedAsTl = tlCodes.has(e.employeeCode) && (!lastSeatRun || (lastTlRun && lastTlRun.from > lastSeatRun.from));
    if (endedAsTl && e.designation !== 'TL') data.designation = 'TL';
    if (currentTl && currentRecruiters.some((x) => x.id === e.id)) {
      if (e.reportingManagerId !== currentTl.id) data.reportingManagerId = currentTl.id;
      if (e.tl !== currentTl.name) data.tl = currentTl.name;
    }
    if (Object.keys(data).length) { await prisma.employee.update({ where: { id: e.id }, data }); report.peopleUpdated += 1; }
  }

  // Seats: replace MED-1…5 / MED-TL history with the file's.
  for (const code of seatCodes) {
    const pos = posByCode.get(code);
    await prisma.positionAssignment.deleteMany({ where: { positionId: pos.id } });
    for (const run of history[code]) {
      await prisma.positionAssignment.create({
        data: { positionId: pos.id, employeeId: run.who.id, fromDate: run.from, toDate: run.until, note: `From the Medical tracker (${run.n} rows)` },
      });
      report.seatSegments += 1;
    }
  }

  // Clients
  for (const entry of newClients) {
    const rest = entry.name.split(',').slice(1).join(',');
    const made = await prisma.client.create({ data: { name: t(entry.name), ownerDepartment: 'Medical', location: t(rest) || null, status: 'Active' } });
    entry.variants.forEach((v) => clientFor.set(v, made.id));
  }

  // Requirement codes continue the existing REQ- series.
  const lastReq = await prisma.requirement.findMany({ where: { reqCode: { startsWith: 'REQ-' } }, select: { reqCode: true } });
  let seq = Math.max(0, ...lastReq.map((x) => Number(String(x.reqCode).slice(4)) || 0));
  const reqCache = new Map();
  async function requirementFor(r, lastRow) {
    const title = titleCase(r.designation || r.specialization || 'Doctor') + (r.designation && r.specialization ? ` — ${titleCase(r.specialization)}` : '');
    const clientId = clientFor.get(r.client);
    const key = `${clientId}|${lc(title)}`;
    if (reqCache.has(key)) return reqCache.get(key);
    const existing = (await prisma.requirement.findMany({ where: { clientId, department: 'Medical' }, select: { id: true, title: true } }))
      .find((x) => lc(x.title) === lc(title));
    if (existing) { reqCache.set(key, existing.id); report.requirements.reused += 1; return existing.id; }
    const tlPerson = person(lastRow.tl, 'TL');
    const recPerson = person(lastRow.recruiter, 'REC');
    const recent = lastRow.date >= new Date(Date.parse(`${TODAY}T00:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
    seq += 1;
    const made = await prisma.requirement.create({
      data: {
        title, clientId, department: 'Medical', specialisation: r.specialization || null,
        status: recent ? 'SOURCING' : 'CLOSED', priority: 'Medium', openings: 1,
        reqCode: `REQ-${String(seq).padStart(4, '0')}`,
        description: `${title}. ${SOURCE}.`,
        location: t(r.client.split(',').slice(1).join(',')) || null,
        tl: tlPerson?.name || null, tlId: activeLogin(tlPerson),
        recruiterId: activeLogin(recPerson), positionCode: lastRow.seat,
        createdAt: new Date(`${r.date}T09:00:00Z`),
      },
    });
    reqCache.set(key, made.id);
    report.requirements.created += 1;
    return made.id;
  }
  // The last row per requirement decides who holds it now.
  const lastRowByReq = new Map();
  usable.forEach((r) => {
    const title = titleCase(r.designation || r.specialization || 'Doctor') + (r.designation && r.specialization ? ` — ${titleCase(r.specialization)}` : '');
    lastRowByReq.set(`${r.client}|${lc(title)}`, r);
  });

  for (const r of usable) {
    const title = titleCase(r.designation || r.specialization || 'Doctor') + (r.designation && r.specialization ? ` — ${titleCase(r.specialization)}` : '');
    const requirementId = await requirementFor(r, lastRowByReq.get(`${r.client}|${lc(title)}`));

    // Candidate
    let cand = await prisma.candidate.findFirst({ where: { phone: { contains: r.phone } } });
    const fill = {
      name: r.name, phone: r.phone, education: r.qualification || null, specialization: r.specialization || null,
      currentDesignation: r.designation || null, experienceYears: years(r.experience), currentSalary: r.currentCtc || null,
      expectedSalary: r.expectedCtc || null, location: r.location || null, preferredLocation: r.preferred || null,
      noticePeriod: r.notice || null,
    };
    if (!cand) {
      cand = await prisma.candidate.create({ data: { ...fill, source: SOURCE, firstSource: SOURCE } });
      report.candidates.created += 1;
    } else {
      const blanks = {};
      Object.entries(fill).forEach(([k, v]) => { if (v != null && v !== '' && (cand[k] == null || cand[k] === '')) blanks[k] = v; });
      if (Object.keys(blanks).length) { await prisma.candidate.update({ where: { id: cand.id }, data: blanks }); report.candidates.filled += 1; }
      report.candidates.matched += 1;
    }

    // Application
    const s = stageOf(r);
    report.stages[s.stage] = (report.stages[s.stage] || 0) + 1;
    if (s.side) report.rejectedBySide[s.side] = (report.rejectedBySide[s.side] || 0) + 1;
    const ctc = annualCtc(r.offered);
    const appData = {
      stage: s.stage,
      source: SOURCE,
      firstSource: SOURCE,
      interviewAt: isoDate(r.ivDate) ? new Date(`${isoDate(r.ivDate)}T10:00:00Z`) : null,
      interviewStatus: s.stage === 'INTERVIEW_COMPLETED' || /interview (is )?completed|interview done/i.test(r.iv) ? 'COMPLETED' : (isoDate(r.ivDate) ? 'SCHEDULED' : null),
      interviewFeedback: r.iv && r.iv !== '-' ? r.iv : null,
      offeredCtc: ctc,
      offerNotes: r.offered ? `Offered (as in the tracker): ${r.offered}` : null,
      joiningDate: isoDate(r.joinDate),
      joiningStatus: r.join || null,
      joinedAt: s.stage === 'JOINED' && isoDate(r.joinDate) ? new Date(`${isoDate(r.joinDate)}T09:00:00Z`) : null,
    };
    const existingApp = await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: cand.id, requirementId } } });
    let app;
    if (existingApp) {
      app = await prisma.application.update({ where: { id: existingApp.id }, data: appData });
      report.applications.updated += 1;
    } else {
      app = await prisma.application.create({ data: { ...appData, candidateId: cand.id, requirementId, createdAt: new Date(`${r.date}T09:00:00Z`) } });
      report.applications.created += 1;
    }

    const rec = person(r.recruiter, 'REC');
    const tlP = person(r.tl, 'TL');
    const pos = posByCode.get(r.seat);
    // One stage event per imported row (replaced on a re-run).
    await prisma.applicationStageEvent.deleteMany({ where: { applicationId: app.id, actorName: IMPORTER } });
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: app.id, candidateId: cand.id, fromStage: null, toStage: s.stage,
        action: STAGE_ACTION[s.stage] || s.stage, comment: r.remarks || null,
        actorName: IMPORTER, actorRole: rec ? 'Recruiter' : null,
        actorSide: s.stage === 'REJECTED' ? (s.side === 'Client' ? 'Client' : 'Candidate') : 'Internal',
        reasonCategory: s.category || null, reasonDetail: s.detail || null,
        actorPositionId: pos?.id || null, actorPositionCode: r.seat,
        requirementId, requirementTitle: title, clientId: clientFor.get(r.client), clientName: r.client,
        createdAt: new Date(`${r.date}T09:00:00Z`),
      },
    });
    // The completed follow-up that carries recruiter / TL / seat and the notes.
    await prisma.applicationFollowUp.deleteMany({ where: { applicationId: app.id, createdByName: IMPORTER } });
    const notes = [
      r.s1 && `Status 1: ${r.s1}`, r.s2 && `Status 2: ${r.s2}`, r.short && `Profile shortlist: ${r.short}`,
      r.ivDate && `Interview date: ${r.ivDate}`, r.iv && `Interview: ${r.iv}`, r.sel && `Selected / rejected: ${r.sel}`,
      r.offered && `Offered CTC: ${r.offered}`, r.join && `Joining: ${r.join}`, r.joinDate && `Joining date: ${r.joinDate}`,
      r.remarks && `Remarks: ${r.remarks}`,
    ].filter(Boolean).join('\n');
    await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id, candidateId: cand.id, requirementId,
        ownerUserId: activeLogin(rec), ownerName: rec?.name || null, ownerRole: 'Recruiter',
        tlUserId: activeLogin(tlP), tlName: tlP?.name || null,
        ownerPositionId: pos?.id || null, ownerPositionCode: r.seat,
        lastContactedAt: new Date(`${r.date}T09:00:00Z`), contactMode: 'Call',
        purpose: 'Medical tracker', notes, outcome: STAGE_ACTION[s.stage] || s.stage,
        completedAt: new Date(`${r.date}T18:00:00Z`), completedNote: SOURCE,
        createdByName: IMPORTER, createdAt: new Date(`${r.date}T09:00:00Z`),
      },
    });
  }

  await prisma.auditLog.create({
    data: { action: 'Medical tracker imported', entity: 'Import', entityId: path.basename(FILE), toValue: JSON.stringify(report).slice(0, 900) },
  });
  console.log(JSON.stringify({ COMMITTED: true, report, problems }, null, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e.message); await prisma.$disconnect(); process.exit(1); });
