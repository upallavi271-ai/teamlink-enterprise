// ---------------------------------------------------------------------------
// CONVERTS THE SECOND BATCH of the company's own sheets into the import
// template: the IT trackers, the BDE profile sheets, the education interview
// history and the two education requirement sheets.
//
//   node scripts/convert-batch2.js <out.xlsx>
//
// Same principle as convert-real-data.js — map into the template, then let the
// validated importer do the writing — but this batch is a different problem.
// The first one was 490 requirements. This is ~13,000 interview rows spanning
// four years, and almost all of the work is deciding WHAT each sheet is:
//
//   a requirement sheet          -> clients + requirements
//   an "interested profiles" sheet -> candidates + where they got to
//   an interview sheet           -> candidates + applications + outcomes
//   a daily-calls sheet          -> NOT IMPORTED (see the end of this file)
//
// READS THE DATABASE, read-only, for one reason: batch 1 already imported 490
// requirements and 124 clients, and this batch's medical sheet overlaps them.
// Matching on content lets an already-imported requirement be reused instead
// of created a second time under a new code. Nothing is written from here.
//
// WHERE APPLICATIONS COME FROM. An application needs a requirement, and a
// candidate sheet names a client and a job but no requirement code. So a
// requirement is created ON DEMAND from (client + title + specialisation) and
// the candidates attach to it. That is the honest reading: a college
// interviewing CSE faculty has a CSE faculty opening, whether or not anybody
// wrote it on the requirements tab.
// ---------------------------------------------------------------------------

const fs = require('fs');
const ExcelJS = require('exceljs');
const prisma = require('../src/db');
const { buildTemplate } = require('../src/utils/importTemplate');
const { nkey, preferred, tidyName, firstPhone, mapStatus } = require('../src/utils/importNormalise');

const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/convert-batch2.js <out.xlsx>'); process.exit(1); }
const DIR = 'C:/Users/user/Downloads/';

// --- cell reading ---------------------------------------------------------
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
  ws.getRow(row).eachCell({ includeEmpty: true }, (c, n) => {
    const t = clean(c.value);
    if (t && !ix[t]) ix[t] = n;
  });
  return ix;
}
// Headers in these sheets carry trailing spaces and typos ("Recuirter name",
// "Shorlisted", "Discription"), so a column is asked for by any of its names
// and matched ignoring case and punctuation.
function col(ix, ...names) {
  for (const n of names) {
    if (ix[n]) return ix[n];
    const hit = Object.keys(ix).find((k) => nkey(k) === nkey(n));
    if (hit) return ix[hit];
  }
  return 0;
}

// A date cell that might be a real date, "26-08-25", "5-5-25" or prose.
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

// --- accumulators --------------------------------------------------------
const clients = new Map();        // nkey -> { name, department, industry, extra }
const specs = new Map();          // `${dept}|${nkey}` -> { department, name }
const people = new Map();         // nkey -> { name, department, designation }
const reqs = new Map();           // content key -> row
const cands = new Map();          // phone/email key -> row
const apps = new Map();           // `${candKey}|${reqKey}` -> row
const existingReqs = new Map();   // content key -> reqCode already in the DB
// Every requirement code already in the database. A code is never reissued:
// the counters below skip straight past anything taken, because handing a new
// requirement a code that already exists would UPDATE that other requirement
// instead of creating this one — silently, and with no error to notice.
const takenCodes = new Set();
const stats = {
  sources: [], skipped: [], unknownStatus: new Map(),
  noKeyCandidates: 0, reusedReqs: 0, nameVariants: new Map(),
};

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

// A recruiter or TL named on a sheet becomes an EMPLOYEE RECORD WITH NO LOGIN.
//
// They have to exist as people for "recruiter-wise" and "team-wise" reports to
// mean anything, and the requirement's assignment columns point at a person.
// But these sheets carry a NAME and nothing else — no email, no employee code
// — and inventing an email to mint a login would create an account nobody can
// use and nobody asked for. So: a record, no login. Administration -> Users
// turns any of them into a login later, on the same record.
function addPerson(name, department, designation) {
  const raw = tidyName(name);
  const k = nkey(raw);
  if (!k || k.length < 3) return null;
  // Track the spellings that collapsed, so the report can show them.
  bump(stats.nameVariants, `${k}|${raw}`);
  const hit = people.get(k);
  if (hit) {
    hit.name = preferred(hit.name, raw);
    if (designation === 'TL') hit.designation = 'TL';
    return hit.name;
  }
  people.set(k, { name: raw, department, designation });
  return raw;
}

// The content key a requirement is identified by, here and against the DB.
const reqKeyOf = (dept, client, title, spec) => [dept, nkey(client), nkey(title), nkey(spec)].join('|');

function addRequirement({ department, client, title, specialisation = '', status = 'OPEN', openings = null, education = '', location = '', description = '', recruiter = '', tl = '' }) {
  const t = clean(title);
  const c = clean(client);
  if (!t || !c) return null;
  const key = reqKeyOf(department, c, t, specialisation);

  // Already in the database from batch 1 — reuse its code rather than making
  // a second requirement for the same job.
  const already = existingReqs.get(key);
  if (already) {
    if (!reqs.has(key)) { stats.reusedReqs += 1; reqs.set(key, { existingCode: already, key }); }
    return key;
  }
  const hit = reqs.get(key);
  if (hit) {
    ['education', 'location', 'description'].forEach((f) => {
      if (!hit[f] && arguments[0][f]) hit[f] = arguments[0][f];
    });
    if (hit.openings == null && openings != null) hit.openings = openings;
    if (!hit.recruiter && recruiter) hit.recruiter = recruiter;
    if (!hit.tl && tl) hit.tl = tl;
    return key;
  }
  reqs.set(key, { key, department, client: c, title: t, specialisation, status, openings, education, location, description, recruiter, tl });
  return key;
}

function addCandidate({ name, phone, email, department, specialisation = '', education = '', experience = '', relevant = '', current = '', currentDesignation = '', ccdc = '', ectc = '', notice = '', location = '', preferred: pref = '', skills = '', source = '', institute = '' }) {
  const nm = tidyName(name);
  const ph = firstPhone(phone);
  const em = clean(email).toLowerCase();
  const key = em && em.includes('@') ? `e:${em}` : (ph ? `p:${ph}` : '');
  if (!key || !nm) { stats.noKeyCandidates += 1; return null; }
  const hit = cands.get(key);
  const row = hit || { key, name: nm, phone: ph, email: em && em.includes('@') ? em : '', department };
  row.name = preferred(row.name, nm);
  if (!row.phone && ph) row.phone = ph;
  if (!row.email && em.includes('@')) row.email = em;
  const fill = { specialisation, education, experience, relevant, current, currentDesignation, ccdc, ectc, notice, location, pref, skills, source, institute };
  Object.entries(fill).forEach(([f, v]) => { if (v && !row[f]) row[f] = v; });
  cands.set(key, row);
  return key;
}

function addApplication(candKey, reqKey, { statusText, interviewDate = '', mode = '', interviewer = '', joiningDate = '', remarks = '', source = '' }) {
  if (!candKey || !reqKey) return;
  const k = `${candKey}|${reqKey}`;
  const mapped = mapStatus(statusText);
  if (statusText && !mapped) bump(stats.unknownStatus, clean(statusText));
  const row = apps.get(k) || { candKey, reqKey };
  // A LATER STAGE WINS. The same candidate appears on a screening tab and an
  // interview tab; the furthest they actually got is the true stage.
  const RANK = ['NEW', 'RECRUITER_REVIEW', 'SHARED_WITH_CLIENT', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'HOLD', 'SELECTED', 'OFFER_ACCEPTED', 'JOINED', 'REJECTED'];
  const next = mapped ? mapped.stage : (row.stage || 'NEW');
  if (!row.stage || RANK.indexOf(next) > RANK.indexOf(row.stage)) {
    row.stage = next;
    if (mapped && mapped.reason) row.reason = mapped.reason;
    if (mapped && mapped.offerStatus) row.offerStatus = mapped.offerStatus;
  }
  if (interviewDate && !row.interviewDate) row.interviewDate = interviewDate;
  if (mode && !row.mode) row.mode = mode;
  if (interviewer && !row.interviewer) row.interviewer = interviewer;
  if (joiningDate && !row.joiningDate) row.joiningDate = joiningDate;
  if (remarks) row.remarks = row.remarks ? `${row.remarks}\n${remarks}` : remarks;
  if (source && !row.source) row.source = source;
  apps.set(k, row);
}

const MODE_MAP = { online: 'Online', offline: 'In Person', telephonic: 'Telephonic', conferencecall: 'Telephonic' };

// ===========================================================================
(async () => {
  // Existing requirements, so batch 1's work is reused rather than duplicated.
  (await prisma.requirement.findMany({
    select: { reqCode: true, title: true, department: true, specialisation: true, client: { select: { name: true } } },
  })).forEach((r) => {
    existingReqs.set(reqKeyOf(r.department || '', r.client.name, r.title, r.specialisation || ''), r.reqCode);
    if (r.reqCode) takenCodes.add(r.reqCode.toUpperCase());
  });
  (await prisma.client.findMany({ select: { name: true } })).forEach((c) => {
    // Seed the client map so an existing client keeps the name it already has.
    clients.set(nkey(c.name), { name: c.name, department: null, industry: null, extra: {}, existing: true });
  });
  console.log(`read ${existingReqs.size} existing requirements and ${clients.size} existing clients (read-only)\n`);

  const open = async (f) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(DIR + f); return wb; };
  const note = (file, sheet, rows, what) => stats.sources.push({ file, sheet, rows, what });

  // =====================================================================
  // 1. EDUCATION REQUIREMENT SHEETS -> colleges + requirements
  // =====================================================================
  // Three sheets of the same thing in three layouts. The "Requirements"
  // column is free text a person wrote ("Qualification:-M.Tech,Cse 2 posts"),
  // so it becomes the requirement's DESCRIPTION and the title is built from
  // the specialisations named in it — not parsed into structured fields it was
  // never written to fill.
  const eduReqSheet = (ws, ix, spec, label, file) => {
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const college = cellOf(ws, r, spec.college);
      if (!college) continue;
      const requirement = cellOf(ws, r, spec.requirement);
      const remarks = cellOf(ws, r, spec.remarks);
      const location = cellOf(ws, r, spec.location);
      const contact = spec.contact ? cellOf(ws, r, spec.contact) : '';
      const phone = spec.phone ? cellOf(ws, r, spec.phone) : '';
      const mail = spec.mail ? cellOf(ws, r, spec.mail) : '';
      const agreement = spec.agreement ? cellOf(ws, r, spec.agreement) : '';
      // Status 1/2/3 and the trailing Remarks are a FOLLOW-UP HISTORY written
      // across columns over years. Kept verbatim in the description: it is the
      // record of every call made to that college and losing it would lose the
      // most useful thing on the sheet.
      const history = (spec.statuses || []).map((c) => cellOf(ws, r, c)).filter(Boolean);

      // "Name of person" IS THE COLLEGE'S OWN CONTACT, not one of our
      // recruiters. Mapping it to the requirement's recruiter is how
      // "Prakash(CSE HOD)" — plainly a head of department at the college —
      // came to be looked up as a TeamLink login, and 1,459 requirements
      // failed on it. It belongs on the CLIENT as their contact person.
      const collegeContact = spec.person ? cellOf(ws, r, spec.person) : '';
      const client = addClient(college, 'Education', 'Education', {
        contactName: contact || collegeContact, contactPhone: firstPhone(phone), contactEmail: mail.includes('@') ? mail.split(/\s+/).find((x) => x.includes('@')) : '',
        street: location, commercialNotes: agreement,
      });

      // Status from the remarks column, which is where these sheets record it.
      const rk = nkey(remarks);
      const status = /norequirement|stop|hold|closed/.test(rk) ? 'CLOSED' : 'OPEN';

      addRequirement({
        department: 'Education',
        client,
        title: requirement ? `Faculty — ${requirement}`.slice(0, 180) : 'Faculty Requirement',
        specialisation: '',
        status,
        education: '',
        location,
        recruiter: '',
        description: [
          requirement ? `Requirement as recorded: ${requirement}` : '',
          agreement ? `Agreement: ${agreement}` : '',
          remarks ? `Remarks: ${remarks}` : '',
          history.length ? `Follow-up history:\n${history.map((h) => `  • ${h}`).join('\n')}` : '',
        ].filter(Boolean).join('\n'),
      });
      rows += 1;
    }
    note(file, label, rows, 'colleges + faculty requirements');
  };

  {
    const wb = await open('Edu - 1 Requirement Sheet .xlsx');
    const ws = wb.getWorksheet('Sheet1');
    const ix = headerIndex(ws);
    eduReqSheet(ws, ix, {
      college: col(ix, 'College name'),
      requirement: col(ix, 'Requirements'),
      remarks: col(ix, 'Remarks'),
      location: col(ix, 'Location'),
      contact: col(ix, 'contact person name & designation', 'contact person name & designat'),
      phone: col(ix, 'Contact number'),
      mail: col(ix, 'Mail id'),
      agreement: col(ix, 'Agreement status&date'),
      statuses: [col(ix, 'Status 1'), col(ix, 'Status 2'), col(ix, 'Status - 3')].filter(Boolean),
    }, 'Sheet1', 'Edu - 1 Requirement Sheet');
    stats.skipped.push('Edu-1 / "KK Wagh Process" — prose process notes, not rows');
    stats.skipped.push('Edu-1 / "Sheet3" — empty');
  }
  {
    const wb = await open('Edu - 2 Requirement Sheet .xlsx');
    const ws = wb.getWorksheet('Sheet1');
    const ix = headerIndex(ws);
    eduReqSheet(ws, ix, {
      college: col(ix, 'colleges'),
      requirement: col(ix, 'Requirements'),
      remarks: col(ix, 'Remarks'),
      location: col(ix, 'Location'),
      contact: col(ix, 'Contact person name & designation', 'Contact person name & designat'),
      phone: col(ix, 'Contact No.'),
      mail: col(ix, 'Mail id'),
      agreement: col(ix, 'Agreement Date'),
      statuses: [col(ix, 'Status 1'), col(ix, 'Status 2 Remaining Comments(07'), col(ix, 'Status 3'), col(ix, 'status')].filter(Boolean),
    }, 'Sheet1', 'Edu - 2 Requirement Sheet');
    stats.skipped.push('Edu-2 / "Sheet2" — Presidency University process notes, not rows');
  }

  const bde = await open('BDE PROFILES.xlsx');
  {
    const ws = bde.getWorksheet('Educational Requirement Sheet');
    const ix = headerIndex(ws);
    eduReqSheet(ws, ix, {
      college: col(ix, 'College names'),
      requirement: col(ix, 'Requirement'),
      remarks: col(ix, 'Remarks'),
      location: col(ix, 'Location'),
      person: col(ix, 'Name of person'),
      statuses: [],
    }, 'Educational Requirement Sheet', 'BDE PROFILES');
  }

  // =====================================================================
  // 2. THE BDE MEDICAL REQUIREMENT SHEET -> more medical requirements
  // =====================================================================
  // Same six-staffing-column shape as the first medical file, so the same
  // rule: a row with a count under Assistant and one under Professor is two
  // requirements. Anything already imported in batch 1 is reused by content.
  {
    const ws = bde.getWorksheet('Medical Requirement Sheet');
    const ix = headerIndex(ws);
    const ROLES = [['Nurse', 'Nurse'], ['Consultant/Doctor', 'Consultant / Doctor'], ['SR', 'Senior Resident'], ['Assistant', 'Assistant Professor'], ['Associate', 'Associate Professor'], ['Professor', 'Professor']];
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const name = cellOf(ws, r, col(ix, 'Client Name'));
      if (!name) continue;
      const client = addClient(name, 'Medical', 'Healthcare');
      const rawSpec = cellOf(ws, r, col(ix, 'Specialization'));
      const isNote = rawSpec.length > 60 || /\d{1,2}-\d{1,2}-\d{2,4}/.test(rawSpec);
      const spec = isNote ? '' : addSpec('Medical', rawSpec);
      const qual = cellOf(ws, r, col(ix, 'Qualification'));
      const pack = cellOf(ws, r, col(ix, 'Package'));
      const remarks = cellOf(ws, r, col(ix, 'Remarks'));
      const status = /stop|closed|norequirement/.test(nkey(remarks)) ? 'CLOSED' : 'OPEN';
      const desc = [
        cellOf(ws, r, col(ix, 'Bed Capacity')) ? `Bed capacity: ${cellOf(ws, r, col(ix, 'Bed Capacity'))}` : '',
        pack ? `Package / experience: ${pack}` : '',
        remarks ? `Remarks: ${remarks}` : '',
        isNote && rawSpec ? `Specialization column note: ${rawSpec}` : '',
      ].filter(Boolean).join('\n');
      let made = 0;
      ROLES.forEach(([h, title]) => {
        const c = col(ix, h);
        if (!c) return;
        const v = cellOf(ws, r, c);
        if (!v) return;
        const n = Number(v.replace(/[^\d.]/g, ''));
        made += 1;
        addRequirement({
          department: 'Medical', client,
          title: spec ? `${title} — ${spec}` : title,
          specialisation: spec, status,
          openings: Number.isFinite(n) && n > 0 && n <= 500 ? Math.round(n) : null,
          education: qual, description: desc,
        });
      });
      if (!made) {
        addRequirement({ department: 'Medical', client, title: spec || 'Medical Requirement', specialisation: spec, status, education: qual, description: desc });
      }
      rows += 1;
    }
    note('BDE PROFILES', 'Medical Requirement Sheet', rows, 'medical requirements (reusing batch 1 where they match)');
  }

  // =====================================================================
  // 3. "INTERESTED PROFILES" -> candidates + applications
  // =====================================================================
  const interestedSheet = (ws, department, label) => {
    const ix = headerIndex(ws);
    const C = {
      date: col(ix, 'Date'), company: col(ix, 'company name', 'Company Name'),
      requirement: col(ix, 'Requirement name'), recruiter: col(ix, 'Recruiter name', 'Recruiter Name'),
      position: col(ix, 'Position name'), cand: col(ix, 'Candidate Name'),
      qual: col(ix, 'Qualification'), branch: col(ix, 'Branch'), exp: col(ix, 'Experience'),
      desig: col(ix, 'Designation'), sal: col(ix, 'Present Salary'), esal: col(ix, 'Expected Salary'),
      loc: col(ix, 'Present Location'), pref: col(ix, 'Preferred Location'),
      notice: col(ix, 'Notice period'), mob: col(ix, 'Mobile Number'), mail: col(ix, 'Mail id'),
      s1: col(ix, 'Status-1'), s2: col(ix, 'Status-2'),
      shortlisted: col(ix, 'Shorlisted/Not shortlisted'), interview: col(ix, 'Interview Status'),
      joined: col(ix, 'joining/ Rejected'), conf: col(ix, 'Coference call'),
    };
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const cand = cellOf(ws, r, C.cand);
      if (!cand) continue;
      const company = cellOf(ws, r, C.company);
      if (!company) continue;
      const client = addClient(company, department, department === 'Education' ? 'Education' : 'Manufacturing');
      const branch = addSpec(department, cellOf(ws, r, C.branch));
      const recruiter = addPerson(cellOf(ws, r, C.recruiter), department, 'Employee');
      const reqTitle = cellOf(ws, r, C.requirement) || cellOf(ws, r, C.position) || 'Requirement';
      const reqKey = addRequirement({
        department, client, title: reqTitle, specialisation: branch,
        status: 'OPEN', recruiter: recruiter || '',
        description: `Created from the ${label} sheet, which recorded candidates against this requirement.`,
      });
      const candKey = addCandidate({
        name: cand, phone: cellOf(ws, r, C.mob), email: cellOf(ws, r, C.mail),
        department, specialisation: branch, education: cellOf(ws, r, C.qual),
        experience: cellOf(ws, r, C.exp), currentDesignation: cellOf(ws, r, C.desig),
        ccdc: cellOf(ws, r, C.sal), ectc: cellOf(ws, r, C.esal),
        notice: cellOf(ws, r, C.notice), location: cellOf(ws, r, C.loc),
        preferred: cellOf(ws, r, C.pref), source: 'BDE calling',
      });
      // The furthest status recorded on the row wins, so the columns are read
      // from the end of the process backwards.
      // THE FURTHEST STATUS ON THE ROW WINS, so the columns are read from
      // the end of the process backwards. The shortlist column holds "yes"
      // or "no", which is an ANSWER and not a stage name — feeding it to
      // the status map produced 166 unrecognised phrases and left those
      // applications wherever they happened to be. It is translated here,
      // where the column's meaning is known.
      const shortlist = nkey(cellOf(ws, r, C.shortlisted));
      const shortlistStage = shortlist === 'yes' ? 'Shortlisted' : (shortlist === 'no' ? 'Not shortlisted' : '');
      const statusText = cellOf(ws, r, C.joined) || cellOf(ws, r, C.interview)
        || shortlistStage || cellOf(ws, r, C.s1);
      addApplication(candKey, reqKey, {
        statusText,
        remarks: [cellOf(ws, r, C.s1) && `Status-1: ${cellOf(ws, r, C.s1)}`, cellOf(ws, r, C.s2) && `Status-2: ${cellOf(ws, r, C.s2)}`, cellOf(ws, r, C.conf) && `Conference call: ${cellOf(ws, r, C.conf)}`].filter(Boolean).join('\n'),
        source: 'BDE calling',
      });
      rows += 1;
    }
    note('BDE PROFILES', label, rows, `${department} candidates + applications`);
  };
  interestedSheet(bde.getWorksheet('Manufacturing Interested Profil'), 'Manufacturing', 'Manufacturing Interested Profiles');
  interestedSheet(bde.getWorksheet('Education Interested Profiles'), 'Education', 'Education Interested Profiles');

  // =====================================================================
  // 4. THE BDE INDEX INTERVIEW SHEET -> interview outcomes
  // =====================================================================
  {
    const ws = bde.getWorksheet('Index Interview Sheet');
    const ix = headerIndex(ws);
    const C = {
      rec: col(ix, 'Recrutier Name', 'Recruiter Name'), cand: col(ix, 'Candidate name'),
      company: col(ix, 'Company name'), phone: col(ix, 'Contact number'),
      desig: col(ix, 'Designation'), r1: col(ix, 'Frist Round', 'First Round'),
      r2: col(ix, 'second Round'), sel: col(ix, 'selected'), hold: col(ix, 'Hold profiles'),
      conf: col(ix, 'Conference call'), done: col(ix, 'interview done Date'),
      out: col(ix, 'Rejected/Selected'), com: col(ix, 'Coments', 'Comments'),
    };
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const cand = cellOf(ws, r, C.cand);
      const company = cellOf(ws, r, C.company);
      if (!cand || !company) continue;
      const client = addClient(company, 'Manufacturing', 'Manufacturing');
      const recruiter = addPerson(cellOf(ws, r, C.rec), 'Manufacturing', 'Employee');
      const title = cellOf(ws, r, C.desig) || 'Requirement';
      const reqKey = addRequirement({ department: 'Manufacturing', client, title, status: 'OPEN', recruiter: recruiter || '' });
      const candKey = addCandidate({ name: cand, phone: cellOf(ws, r, C.phone), department: 'Manufacturing', currentDesignation: cellOf(ws, r, C.desig), source: 'BDE calling' });
      const statusText = cellOf(ws, r, C.out) || cellOf(ws, r, C.sel) || cellOf(ws, r, C.r2) || cellOf(ws, r, C.r1);
      addApplication(candKey, reqKey, {
        statusText,
        interviewDate: asDate(cellOf(ws, r, C.done)),
        remarks: [cellOf(ws, r, C.r1) && `Round 1: ${cellOf(ws, r, C.r1)}`, cellOf(ws, r, C.r2) && `Round 2: ${cellOf(ws, r, C.r2)}`, cellOf(ws, r, C.conf) && `Conference call: ${cellOf(ws, r, C.conf)}`, cellOf(ws, r, C.com) && `Comments: ${cellOf(ws, r, C.com)}`].filter(Boolean).join('\n'),
      });
      rows += 1;
    }
    note('BDE PROFILES', 'Index Interview Sheet', rows, 'interview outcomes');
  }

  // The two activity sheets. NOT IMPORTED, and this is the reason:
  stats.skipped.push('BDE / "Promotion sheet" (155 rows) — DAILY CALLING TOTALS per recruiter (total / success / failed data). These are activity metrics, not records: there is no table for "calls made per recruiter per day" and inventing candidates from a count would be fabrication. Worth a small sourcing-activity model if the numbers are wanted in reports.');
  stats.skipped.push('BDE / "Vicidial Data" (1,017 rows) — dialler totals per recruiter per day (total / connected / interested / callbacks). Same reason.');

  // =====================================================================
  // 5. THE EDUCATION INTERVIEW HISTORY -> the big one
  // =====================================================================
  {
    const wb = await open('Education Interview Sheet-2022-2026.xlsx');
    const ws = wb.getWorksheet('Daily Interviews ');
    const ix = headerIndex(ws);
    const C = {
      cand: col(ix, 'Candidate Name'), phone: col(ix, 'Contact Number'),
      qual: col(ix, 'Qualification'), spec: col(ix, 'Specialization'),
      exp: col(ix, 'Experience'), ctc: col(ix, 'Current CTC'), ectc: col(ix, 'Expected CTC'),
      certs: col(ix, 'In hand Certificates'), docs: col(ix, 'Documents Confirmation'),
      notice: col(ix, 'Notice Period'), loc: col(ix, 'current location'), pref: col(ix, 'Preferred Location'),
      college: col(ix, 'College Name'), mode: col(ix, 'Interview Mode'),
      offered: col(ix, 'Offered Salary'), joining: col(ix, 'Joining date'),
      idate: col(ix, 'Interview Date'), istatus: col(ix, 'Interview Status'),
      rec: col(ix, 'Recruiter Name'), tl: col(ix, 'TL Name'),
      follow: col(ix, 'Last Followup'), source: col(ix, 'Source'),
    };
    let rows = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const cand = cellOf(ws, r, C.cand);
      const college = cellOf(ws, r, C.college);
      if (!cand || !college) continue;
      const client = addClient(college, 'Education', 'Education');
      const spec = addSpec('Education', cellOf(ws, r, C.spec));
      const recruiter = addPerson(cellOf(ws, r, C.rec), 'Education', 'Employee');
      const tl = addPerson(cellOf(ws, r, C.tl), 'Education', 'TL');
      // A faculty interview at a college IS a faculty opening in that
      // specialisation, whether or not it was written on a requirements tab.
      const reqKey = addRequirement({
        department: 'Education', client,
        title: spec ? `Faculty — ${spec}` : 'Faculty',
        specialisation: spec, status: 'OPEN',
        education: cellOf(ws, r, C.qual),
        recruiter: recruiter || '', tl: tl || '',
        description: 'Created from the education interview history, which recorded candidates interviewed for this post.',
      });
      const candKey = addCandidate({
        name: cand, phone: cellOf(ws, r, C.phone), department: 'Education',
        specialisation: spec, education: cellOf(ws, r, C.qual),
        experience: cellOf(ws, r, C.exp), ccdc: cellOf(ws, r, C.ctc), ectc: cellOf(ws, r, C.ectc),
        notice: cellOf(ws, r, C.notice), location: cellOf(ws, r, C.loc), preferred: cellOf(ws, r, C.pref),
        source: cellOf(ws, r, C.source) || 'Education interview sheet',
      });
      addApplication(candKey, reqKey, {
        statusText: cellOf(ws, r, C.istatus),
        interviewDate: asDate(cellOf(ws, r, C.idate)),
        mode: MODE_MAP[nkey(cellOf(ws, r, C.mode))] || '',
        joiningDate: asDate(cellOf(ws, r, C.joining)),
        remarks: [
          cellOf(ws, r, C.follow) && `Last follow-up: ${cellOf(ws, r, C.follow)}`,
          cellOf(ws, r, C.offered) && `Offered salary: ${cellOf(ws, r, C.offered)}`,
          cellOf(ws, r, C.certs) && `Certificates in hand: ${cellOf(ws, r, C.certs)}`,
          cellOf(ws, r, C.docs) && `Documents: ${cellOf(ws, r, C.docs)}`,
        ].filter(Boolean).join('\n'),
        source: cellOf(ws, r, C.source),
      });
      rows += 1;
    }
    note('Education Interview Sheet', 'Daily Interviews', rows, 'education candidates + interview history');

    // Profile Screening — the stage before an interview.
    const ps = wb.getWorksheet('Profile Screening ');
    const pix = headerIndex(ps);
    const P = {
      cand: col(pix, 'Candidate Name'), phone: col(pix, 'Contact'), mail: col(pix, 'Mail id'),
      qual: col(pix, 'Qualification'), branch: col(pix, 'Branch'), exp: col(pix, 'Experience'),
      sal: col(pix, 'Present Salary'), esal: col(pix, 'Expected Salary'),
      loc: col(pix, 'Present Location'), pref: col(pix, 'Preferred Location'),
      notice: col(pix, 'Notice Period'), college: col(pix, 'Interview College Name'),
      mode: col(pix, 'Interview Mode'), idate: col(pix, 'Interview Date'),
      istatus: col(pix, 'Interview Status'), faculty: col(pix, 'Type Of faculty'),
      rec: col(pix, 'Recruiter Name'), tl: col(pix, 'TL Name'),
      status: col(pix, 'Status'), remarks: col(pix, 'Remarks'),
    };
    let prows = 0;
    for (let r = 2; r <= ps.rowCount; r += 1) {
      const cand = cellOf(ps, r, P.cand);
      const college = cellOf(ps, r, P.college);
      if (!cand) continue;
      const branch = addSpec('Education', cellOf(ps, r, P.branch));
      const recruiter = addPerson(cellOf(ps, r, P.rec), 'Education', 'Employee');
      addPerson(cellOf(ps, r, P.tl), 'Education', 'TL');
      const candKey = addCandidate({
        name: cand, phone: cellOf(ps, r, P.phone), email: cellOf(ps, r, P.mail),
        department: 'Education', specialisation: branch, education: cellOf(ps, r, P.qual),
        experience: cellOf(ps, r, P.exp), ccdc: cellOf(ps, r, P.sal), ectc: cellOf(ps, r, P.esal),
        notice: cellOf(ps, r, P.notice), location: cellOf(ps, r, P.loc), preferred: cellOf(ps, r, P.pref),
        source: 'Profile screening',
      });
      // Only attach an application where a college is named — a screened
      // profile with no college is a candidate in the bench, not an
      // application to somewhere unknown.
      if (college) {
        const client = addClient(college, 'Education', 'Education');
        const title = cellOf(ps, r, P.faculty) ? `${cellOf(ps, r, P.faculty)}${branch ? ` — ${branch}` : ''}` : (branch ? `Faculty — ${branch}` : 'Faculty');
        const reqKey = addRequirement({
          department: 'Education', client, title, specialisation: branch, status: 'OPEN',
          education: cellOf(ps, r, P.qual), recruiter: recruiter || '',
          description: 'Created from the profile screening sheet.',
        });
        addApplication(candKey, reqKey, {
          statusText: cellOf(ps, r, P.istatus) || cellOf(ps, r, P.status),
          interviewDate: asDate(cellOf(ps, r, P.idate)),
          mode: MODE_MAP[nkey(cellOf(ps, r, P.mode))] || '',
          remarks: cellOf(ps, r, P.remarks) && `Screening remarks: ${cellOf(ps, r, P.remarks)}`,
          source: 'Profile screening',
        });
      }
      prows += 1;
    }
    note('Education Interview Sheet', 'Profile Screening', prows, 'screened education candidates');
  }

  // =====================================================================
  // 6. THE IT TRACKERS -> candidates + client submissions
  // =====================================================================
  // Thirteen tabs, mostly one per recruiter, in four layouts. Each row is a
  // candidate SUBMITTED to a client, so the client is the account and the
  // requirement is the skill or position.
  {
    const wb = await open('Tracker sheet.xlsx');
    for (const ws of wb.worksheets) {
      const ix = headerIndex(ws);
      const C = {
        cand: col(ix, 'Candidate Name', 'Name Of Candidate', 'Candidate Full Name', 'Candidate Names', 'Candidate'),
        phone: col(ix, 'Contact no', 'Mobile', 'Mobile No', 'Contact Number', 'Mobile No.', 'contact number'),
        mail: col(ix, 'Email', 'Email ID', 'Email Id', 'Candidate Email'),
        skill: col(ix, 'Skill', 'Skill Name', 'Position Type', 'Role'),
        client: col(ix, 'Client Name', 'Account Name', 'Project Name', 'Client'),
        rec: col(ix, 'Recruiter', 'Recruiter SPOC', 'Screening', 'Internal Lead'),
        spoc: col(ix, 'Spoc Name', 'Spoc', 'Delivery SPOC'),
        exp: col(ix, 'Exp', 'Total Experience', 'Total Experience (In Years', 'Total Experience (In )'),
        rel: col(ix, 'Rel Ex', 'Relevant Experience', 'Relevant Experience (In Ye', 'Relevant Experience (In )'),
        company: col(ix, 'Current company', 'Current Company'),
        ctc: col(ix, 'CTC', 'Current CTC', 'Current CTC (In LPA)', 'Current CTC (In )'),
        ectc: col(ix, 'ECTC', 'Expected CTC', 'Expected CTC (In LPA)', 'Expected CTC (In )'),
        notice: col(ix, 'Notice period', 'Notice Period', 'Notice period in days', 'Notice period in'),
        loc: col(ix, 'Current Location', 'Current location'),
        pref: col(ix, 'Prefered location', 'Preferred Location', 'Preffered Location', 'Preferred location', 'Preffered location', 'Work Location'),
        status: col(ix, 'Status Update', 'Selected/ Rejected', 'Rejected/Selected', 'Final Status', 'Status'),
        sub: col(ix, 'Submission Date', 'submission date', 'Submission date', 'Date', 'Sourcing Data', 'Sourcing Date'),
        reason: col(ix, 'Reason', 'Remarks'),
        source: col(ix, 'Source', 'Vendor Name', 'Vendor', 'Source Details'),
        l1: col(ix, 'L1 Interview Date', 'L1 Scheduled Date', 'Client L1 Date', 'Client L1 interview Date'),
        panel: col(ix, 'Panel Name', 'L1 Panel Name'),
        edu: col(ix, 'Education'),
      };
      if (!C.cand) { stats.skipped.push(`Tracker / "${ws.name}" — no candidate-name column (empty or a notes tab)`); continue; }
      let rows = 0;
      for (let r = 2; r <= ws.rowCount; r += 1) {
        const cand = cellOf(ws, r, C.cand);
        if (!cand) continue;
        // A tab with no client column is one account's own tracker; the tab is
        // named after the recruiter, not the client, so the client comes from
        // the row and falls back to the vendor/account when absent.
        const clientName = cellOf(ws, r, C.client) || cellOf(ws, r, C.source) || 'NTT Data';
        const client = addClient(clientName, 'IT', 'Information Technology');
        const skill = cellOf(ws, r, C.skill);
        const spec = addSpec('IT', skill);
        const recruiter = addPerson(cellOf(ws, r, C.rec) || cellOf(ws, r, C.spoc), 'IT', 'Employee');
        const reqKey = addRequirement({
          department: 'IT', client,
          title: skill || 'IT Requirement',
          specialisation: spec, status: 'OPEN',
          recruiter: recruiter || '',
          description: `Created from the IT tracker tab "${ws.name.trim()}".`,
        });
        const candKey = addCandidate({
          name: cand, phone: cellOf(ws, r, C.phone), email: cellOf(ws, r, C.mail),
          department: 'IT', skills: skill, specialisation: spec,
          experience: cellOf(ws, r, C.exp), relevant: cellOf(ws, r, C.rel),
          current: cellOf(ws, r, C.company), ccdc: cellOf(ws, r, C.ctc), ectc: cellOf(ws, r, C.ectc),
          notice: cellOf(ws, r, C.notice), location: cellOf(ws, r, C.loc), preferred: cellOf(ws, r, C.pref),
          education: cellOf(ws, r, C.edu), source: cellOf(ws, r, C.source) || 'IT tracker',
        });
        addApplication(candKey, reqKey, {
          statusText: cellOf(ws, r, C.status),
          interviewDate: asDate(cellOf(ws, r, C.l1)),
          interviewer: cellOf(ws, r, C.panel),
          remarks: [
            cellOf(ws, r, C.sub) && `Submitted: ${cellOf(ws, r, C.sub)}`,
            cellOf(ws, r, C.spoc) && `Client SPOC: ${cellOf(ws, r, C.spoc)}`,
            cellOf(ws, r, C.reason) && `Reason / remarks: ${cellOf(ws, r, C.reason)}`,
          ].filter(Boolean).join('\n'),
          source: cellOf(ws, r, C.source) || 'IT tracker',
        });
        rows += 1;
      }
      if (rows) note('Tracker sheet', ws.name.trim(), rows, 'IT candidates + submissions');
      else stats.skipped.push(`Tracker / "${ws.name.trim()}" — no data rows`);
    }
  }

  // =====================================================================
  // WRITE THE TEMPLATE
  // =====================================================================
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

  const DEPTS = ['Education', 'IT', 'Medical', 'Manufacturing'];
  put('Departments', DEPTS.map((d) => ({ Department: d, Team: `${d} Team-A` })));
  put('Specialisations', [...specs.values()].map((s) => ({ Department: s.department, Specialisation: s.name })));

  // Employees: recruiters and TLs, NO LOGINS. See addPerson above.
  let pn = 0;
  put('Employees', [...people.values()].map((p) => {
    pn += 1;
    return {
      'Employee Code': `TL-${String(pn).padStart(4, '0')}`,
      'Full Name': p.name,
      Department: p.department,
      Team: `${p.department} Team-A`,
      Designation: p.designation === 'TL' ? 'TL' : 'Employee',
      'Employment Status': 'Active',
      'Create Login': 'No',
    };
  }));

  put('Clients', [...clients.values()].filter((c) => !c.existing).map((c) => ({
    'Client Name': c.name,
    Industry: c.industry || '',
    Status: 'Active',
    'Owning Department': c.department || '',
    'Client Type': 'Direct',
    'Primary Contact Name': c.extra.contactName || '',
    'Primary Contact Phone': c.extra.contactPhone || '',
    'Primary Contact Email': c.extra.contactEmail || '',
    Address: c.extra.street || '',
    'Commercial Notes': c.extra.commercialNotes || '',
  })));

  // Requirement codes. New prefixes per department, and the numbering starts
  // at 1001 for Medical and Manufacturing so it cannot collide with batch 1's
  // MED-0001..0333 and MFG-0001..0157.
  const PREFIX = { Education: ['EDU', 0], IT: ['ITR', 0], Medical: ['MED', 1000], Manufacturing: ['MFG', 1000] };
  const counters = {};
  const codeFor = new Map();
  // RESOLVE EVERY NAME ONE LAST TIME, now that all the sheets have been
  // read. addSpec() and addClient() return the best spelling known AT THAT
  // MOMENT, and a later row can improve it — so a requirement written early
  // could hold "EEE" while the specialisations sheet ends up saying
  // "E.E.E". Same value, different string, and the importer then could not
  // match them. Re-reading both maps here makes the workbook internally
  // consistent by construction rather than by luck.
  reqs.forEach((r) => {
    if (r.existingCode) return;
    if (r.specialisation) {
      const s = specs.get(`${r.department}|${nkey(r.specialisation)}`);
      if (s) r.specialisation = s.name;
    }
    const c = clients.get(nkey(r.client));
    if (c) r.client = c.name;
  });

  const reqRows = [];
  [...reqs.values()].forEach((r) => {
    if (r.existingCode) { codeFor.set(r.key, r.existingCode); return; }
    const [p, base] = PREFIX[r.department] || ['REQ', 0];
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
      Openings: r.openings,
      Education: r.education || '',
      Location: r.location || '',
      'Assigned Recruiter': r.recruiter || '',
      'Assigned TL': r.tl || '',
      'Job Description': r.description || '',
      'Hiring Type': 'Client Placement',
    });
  });
  put('Requirements', reqRows);

  put('Candidates', [...cands.values()].map((c) => ({
    'Full Name': c.name,
    Email: c.email || '',
    Phone: c.phone || '',
    'Current Location': c.location || '',
    'Preferred Location': c.pref || '',
    'Current Company': c.current || '',
    'Current Designation': c.currentDesignation || '',
    'Current Salary': c.ccdc || '',
    'Expected Salary': c.ectc || '',
    'Notice Period': c.notice || '',
    Education: c.education || '',
    Specialisation: c.specialisation || '',
    'Mandatory Skills': c.skills || '',
    Source: c.source || '',
  })));

  const appRows = [];
  apps.forEach((a) => {
    const cand = cands.get(a.candKey);
    const code = codeFor.get(a.reqKey);
    if (!cand || !code) return;
    appRows.push({
      'Candidate Email or Phone': cand.email || cand.phone,
      'Requirement Code': code,
      Stage: a.stage || 'NEW',
      'Interview Date/Time': a.interviewDate || '',
      'Interview Mode': a.mode || '',
      Interviewer: a.interviewer || '',
      'Offer Status': a.offerStatus || '',
      'Joining Date': a.joiningDate || '',
      'Rejection Reason': a.stage === 'REJECTED' ? (a.reason || 'Recorded as rejected on the source sheet') : '',
      Source: a.source || '',
      'Interview Feedback': (a.remarks || '').slice(0, 1800),
    });
  });
  put('Applications', appRows);

  fs.writeFileSync(OUT, Buffer.from(await wb.xlsx.writeBuffer()));

  // --- report -------------------------------------------------------------
  console.log(`Wrote ${OUT}\n`);
  console.log('READ FROM:');
  stats.sources.forEach((s) => console.log(`  ${s.file.padEnd(26)} ${s.sheet.padEnd(34)} ${String(s.rows).padStart(6)} rows  -> ${s.what}`));
  console.log('\nPRODUCED:');
  console.log(`  ${DEPTS.length} departments        ${DEPTS.join(', ')}`);
  console.log(`  ${specs.size} specialisations`);
  console.log(`  ${people.size} people (recruiters + TLs), NO LOGINS`);
  console.log(`  ${[...clients.values()].filter((c) => !c.existing).length} new clients (${[...clients.values()].filter((c) => c.existing).length} already in the system)`);
  console.log(`  ${reqRows.length} new requirements (${stats.reusedReqs} reused from batch 1 by content)`);
  console.log(`  ${cands.size} candidates`);
  console.log(`  ${appRows.length} applications`);
  const byStage = {};
  appRows.forEach((a) => { byStage[a.Stage] = (byStage[a.Stage] || 0) + 1; });
  console.log('\n  applications by stage:');
  Object.entries(byStage).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`      ${String(n).padStart(6)}  ${s}`));

  console.log('\nJUDGEMENTS AND GAPS:');
  console.log(`  ${stats.noKeyCandidates} candidate rows had no phone and no email and could not be told apart — not imported`);
  if (stats.unknownStatus.size) {
    console.log(`  ${stats.unknownStatus.size} status phrases were not recognised (those applications are left at their earlier stage):`);
    [...stats.unknownStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .forEach(([k, n]) => console.log(`      ${String(n).padStart(5)} x "${k.slice(0, 56)}"`));
  }
  // Names that differ only by a leading initial — probably one person, not
  // merged, because "probably" is not a decision to take inside an import.
  // Names that differ ONLY by a leading initial — "P.Badri" and "Badri",
  // "E. Anusha" and "Anusha". Reported, never merged: one initial apart is
  // usually one person and occasionally two, and that is not a call to make
  // silently inside an import.
  //
  // The initial has to be a REAL one — a single letter followed by a dot or
  // a space in the ORIGINAL name. Stripping the first letter of anything
  // matched "Navya" to "Kavya" and "maneesha" to "D.Aneesha", which are
  // different people, and a false alarm in this report is worse than none.
  const tailOf = (n) => {
    const m = /^([A-Za-z])[.s]s*(.+)$/.exec(n.trim());
    return m ? nkey(m[2]) : nkey(n);
  };
  const byTail = {};
  [...people.values()].forEach((p2) => {
    const t = tailOf(p2.name);
    if (t.length < 4) return;
    (byTail[t] = byTail[t] || []).push(p2.name);
  });
  const maybe = Object.values(byTail).filter((g) => g.length > 1);
  if (maybe.length) {
    console.log(`  ${maybe.length} name groups MIGHT be the same person written with and without an initial — NOT merged, please confirm:`);
    maybe.slice(0, 10).forEach((g) => console.log(`      ${g.join('  /  ')}`));
  }
  console.log('\nNOT IMPORTED:');
  stats.skipped.forEach((s) => console.log(`  • ${s}`));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
