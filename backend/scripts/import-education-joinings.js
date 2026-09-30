/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// EDUCATION TEAM B (EDU-6 … EDU-10) — JOININGS SHEET IMPORT
//
//   node scripts/import-education-joinings.js "<file.xlsx>"            dry run
//   node scripts/import-education-joinings.js "<file.xlsx>" --commit   write
//
// The sheet ("Education Team B 6 -10 Recrutiers Joining Status.xlsx") is one
// row per candidate who joined, with the recruiter, the TL and the seat they
// worked from. Its data rows sit one column LEFT of the header row (there is
// no S.No value), and the column headed "Position" is the candidate's status
// after joining — the seat is in the unheaded column after it:
//
//   0 Name · 1 Contact · 2 Qualification · 3 Branch · 4 Invoice No ·
//   5 College · 6 Interview Date · 7 Joined Date · 8 Salary (monthly) ·
//   9 Recruiter · 10 TL · 11 Status · 12 Seat ("Edu 6")
//
// Status, as confirmed with the user: "Continue" = joined and still there;
// a date / month = joined, then left then; "Drop" = did NOT join (not counted
// as a joining); blank = joined, current status not recorded.
//
// What it writes (same shape as scripts/import-medical-tracker.js):
//   * SEAT HISTORY for EDU-6…10 and EDU-TL, replaced with the sheet's — who sat
//     in each seat, from when to when, and who took over. Confirmed with the
//     user: the sheet is right about TODAY too (supriya P in EDU-8, Anitha
//     Gandu in EDU-10), so the 23-Sep seatings that disagree are removed.
//   * The former people (Tejasri, Manideep, Niharika, Lakshmi, TL Anjali)
//     move to the Education department, as the Medical ones did.
//   * Each joining: the candidate (found by phone, else created), the
//     application at that college (an existing one is moved to Joined, never
//     duplicated), one stage event and one completed follow-up carrying the
//     recruiter / TL / seat, and the invoice linked when its number exists.
// ---------------------------------------------------------------------------
const path = require('path');
const XLSX = require('xlsx');
const prisma = require('../src/db');

const FILE = process.argv[2];
const COMMIT = process.argv.includes('--commit');
const IMPORTER = 'Imported — Education Team B joinings';
const SOURCE = 'Education Team B joinings sheet';
const DEPT = 'Education';

// Sheet spelling (letters only, lower case) → employee code. Confirmed by the
// TL on each former employee's record: all four report to Popuri Anjali.
const PEOPLE = {
  krenuka: 'TL487', tejasri: 'TL463', suma: 'TL505', manideep: 'TL457', psupriya: 'TL480',
  knaveena: 'TL470', niharika: 'TL465', lakshmi: 'TL425', ganitha: 'TL512',
};
const TLS = { anjali: 'TL433', msaisirisha: 'TL448' };
const SEATS = ['EDU-6', 'EDU-7', 'EDU-8', 'EDU-9', 'EDU-10'];
const TL_SEAT = 'EDU-TL';
// Seatings the sheet says are wrong today (confirmed with the user).
const CLEAR_SEAT_OF = [{ employeeCode: 'TL512', code: 'EDU-12' }];

const t = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const lc = (v) => t(v).toLowerCase();
const key = (v) => lc(v).replace(/[^a-z]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const titleCase = (s) => t(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

function ymd(y, mo, d) {
  let year = Number(y);
  if (year < 100) year += 2000;
  const month = Number(mo);
  const day = Number(d);
  if (year < 2020 || year > 2030 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}
// "8 July 2026", "18 Aug 2026", "22-Aug-26", "1-Sep-26"
function isoDate(v) {
  const s = lc(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\s\-/.]+([a-z]{3,})[\s\-/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].slice(0, 3)]) return ymd(m[3], MONTHS[m[2].slice(0, 3)], m[1]);
  const n = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  return n ? ymd(n[3], n[2], n[1]) : null;
}
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const minIso = (...xs) => xs.filter(Boolean).sort()[0] || null;
const maxIso = (...xs) => xs.filter(Boolean).sort().pop() || null;
const monthly = (v) => { const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

function seatOf(v) {
  const m = lc(v).match(/edu\W*(\d{1,2})/);
  return m ? `EDU-${Number(m[1])}` : null;
}
// Continue / a date / a month / Drop / blank.
function statusOf(v, joinIso) {
  const s = lc(v);
  if (!s) return { joined: true, note: 'Joined — current status not recorded' };
  if (/^drop/.test(s)) return { joined: false, note: 'Dropped — did not join' };
  if (/^contin/.test(s)) return { joined: true, note: 'Joined — still continuing' };
  const d = isoDate(v);
  if (d) return { joined: true, leftOn: d, note: `Joined — left on ${d}` };
  const mon = MONTHS[s.slice(0, 3)];
  if (mon) {
    const y = Number(joinIso.slice(0, 4)) + (mon < Number(joinIso.slice(5, 7)) ? 1 : 0);
    return { joined: true, leftOn: `${y}-${pad(mon)}`, note: `Joined — left in ${titleCase(v)} ${y}` };
  }
  return { joined: true, note: `Joined — status "${t(v)}"` };
}

// College names: the sheet writes "ST.Peters", "Holly Mary", "Siddartha-
// Ibbrahimpatnam"; the clients are "St. Peter's", "Holy Mary", "Siddartha
// -Ibrahimpatnam". Compared as letters-and-digits only, after the typos.
function compact(s) {
  return lc(s).replace(/ibbrahim/g, 'ibrahim').replace(/\bholly\b/g, 'holy').replace(/[^a-z0-9]/g, '');
}

(async () => {
  if (!FILE) throw new Error('Pass the .xlsx path.');
  const grid = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets.Sheet1, { header: 1, defval: '', raw: false });
  const problems = [];
  const rows = grid.slice(1).map((r, i) => ({
    line: i + 2,
    name: t(r[0]), phone: phone10(r[1]), qualification: t(r[2]), branch: t(r[3]), invoiceNo: t(r[4]),
    college: t(r[5]), ivDate: isoDate(r[6]), joinDate: isoDate(r[7]), salary: monthly(r[8]),
    recruiterKey: key(r[9]), tlKey: key(r[10]), statusRaw: t(r[11]), seat: seatOf(r[12]),
    rawIv: t(r[6]), rawJoin: t(r[7]),
  })).filter((r) => r.name);
  rows.forEach((r) => {
    r.status = statusOf(r.statusRaw, r.joinDate || '2026-01-01');
    if (!r.phone) problems.push(`line ${r.line}: no 10-digit phone for ${r.name}`);
    if (!r.joinDate) problems.push(`line ${r.line}: joined date "${r.rawJoin}" unreadable`);
    if (!r.ivDate) problems.push(`line ${r.line}: interview date "${r.rawIv}" unreadable`);
    if (!r.seat) problems.push(`line ${r.line}: seat unreadable`);
    if (!PEOPLE[r.recruiterKey]) problems.push(`line ${r.line}: recruiter "${r.recruiterKey}" not mapped`);
    if (!TLS[r.tlKey]) problems.push(`line ${r.line}: TL "${r.tlKey}" not mapped`);
  });
  if (problems.length) { console.log(JSON.stringify({ problems }, null, 1)); throw new Error('Fix the problems above first.'); }

  // ---- people -----------------------------------------------------------------
  const codes = [...Object.values(PEOPLE), ...Object.values(TLS)];
  const people = await prisma.employee.findMany({
    where: { employeeCode: { in: codes } },
    include: { user: { select: { id: true, status: true } } },
  });
  const byCode = new Map(people.map((e) => [e.employeeCode, e]));
  codes.forEach((c) => { if (!byCode.has(c)) throw new Error(`employee ${c} not found`); });
  const rec = (r) => byCode.get(PEOPLE[r.recruiterKey]);
  const tlOf = (r) => byCode.get(TLS[r.tlKey]);
  const gone = (e) => ['Relieved', 'Exited', 'Exit Process'].includes(e.employmentStatus);
  const login = (e) => (e && e.user && e.user.status !== 'Inactive' && !gone(e) ? e.user.id : null);
  const doj = (e) => (e.dateOfJoining ? e.dateOfJoining.toISOString().slice(0, 10) : null);

  // ---- seat history -------------------------------------------------------------
  // Holders in order of first activity. A seat starts at the holder's joining
  // date or first interview, whichever is earlier — but never before the day
  // after the previous holder's last joining. It ends the day before the next
  // holder starts; the last holder is still in it unless they have left.
  function tenures(list) {
    const byPerson = new Map();
    list.forEach(({ who, iv, join }) => {
      const x = byPerson.get(who.id) || { who, first: iv || join, last: join || iv, n: 0 };
      x.first = minIso(x.first, iv, join); x.last = maxIso(x.last, join); x.n += 1;
      byPerson.set(who.id, x);
    });
    const runs = [...byPerson.values()].sort((a, b) => a.first.localeCompare(b.first));
    runs.forEach((run, i) => {
      const prev = runs[i - 1];
      const start = minIso(doj(run.who), run.first);
      run.from = prev ? maxIso(addDays(prev.last, 1), start) : start;
    });
    runs.forEach((run, i) => {
      const next = runs[i + 1];
      run.until = next ? addDays(next.from, -1) : (gone(run.who) ? run.last : null);
    });
    return runs;
  }
  const joinedRows = rows; // drops still show who worked the seat then
  const history = {};
  SEATS.forEach((code) => {
    history[code] = tenures(joinedRows.filter((r) => r.seat === code).map((r) => ({ who: rec(r), iv: r.ivDate, join: r.joinDate })));
  });
  history[TL_SEAT] = tenures(joinedRows.map((r) => ({ who: tlOf(r), iv: r.ivDate, join: r.joinDate })));
  const positions = await prisma.position.findMany({ where: { code: { in: [...SEATS, TL_SEAT, ...CLEAR_SEAT_OF.map((c) => c.code)] } } });
  const posByCode = new Map(positions.map((p) => [p.code, p]));
  [...SEATS, TL_SEAT].forEach((c) => { if (!posByCode.has(c)) throw new Error(`seat ${c} not found`); });
  const seatNow = await prisma.positionAssignment.findMany({
    where: { position: { code: { in: [...SEATS, TL_SEAT, ...CLEAR_SEAT_OF.map((c) => c.code)] } } },
    include: { position: { select: { code: true } }, employee: { select: { name: true, employeeCode: true } } },
  });

  // ---- clients ------------------------------------------------------------------
  const clients = await prisma.client.findMany({ select: { id: true, name: true, ownerDepartment: true } });
  const reqCounts = new Map((await prisma.requirement.groupBy({ by: ['clientId'], _count: true })).map((g) => [g.clientId, g._count]));
  const weight = (c) => (c.ownerDepartment === DEPT ? 100000 : 0) + (reqCounts.get(c.id) || 0);
  const clientFor = new Map();
  const clientHow = [];
  for (const college of [...new Set(rows.map((r) => r.college))]) {
    const k = compact(college);
    let pool = clients.filter((c) => compact(c.name) === k);
    let how = 'exact';
    if (!pool.length) {
      pool = clients.filter((c) => { const ck = compact(c.name); return ck.length >= 4 && k.length >= 4 && (ck.startsWith(k) || k.startsWith(ck)); });
      how = 'prefix';
    }
    if (!pool.length) { clientHow.push(`${college} → NOT FOUND (will be created)`); continue; }
    const best = pool.sort((a, b) => weight(b) - weight(a))[0];
    clientFor.set(college, best);
    clientHow.push(`${college} → ${best.name} [${how}${pool.length > 1 ? `, best of ${pool.length}` : ''}; ${reqCounts.get(best.id) || 0} requirements]`);
  }

  // ---- per row plan -------------------------------------------------------------
  const plan = [];
  for (const r of rows) {
    const cands = await prisma.candidate.findMany({
      where: { phone: { contains: r.phone } },
      include: { applications: { include: { requirement: { select: { id: true, title: true, department: true, client: { select: { id: true, name: true } } } } } } },
    });
    // THE PHONE MUST BELONG TO THIS PERSON. Line 26 (Gaddam Vaishnavi) carries
    // line 41's number (Chipurushetti Sunanda) — a copy slip in the sheet — so
    // a phone match whose name shares no word with the row is not a match; the
    // candidate is then looked up by name, and a new one gets no phone.
    const words = (x) => lc(x).replace(/[^a-z ]/g, ' ').split(/s+/).filter((w) => w.length > 2);
    const mine = words(r.name);
    let cand = cands.find((c) => words(c.name).some((w) => mine.includes(w))) || null;
    if (!cand && cands.length) {
      r.phoneBelongsTo = cands[0].name;
      r.phone = null;
      const byName = await prisma.candidate.findMany({
        where: { name: { contains: r.name.split(' ')[0] } },
        include: { applications: { include: { requirement: { select: { id: true, title: true, department: true, client: { select: { id: true, name: true } } } } } } },
      });
      cand = byName.find((c) => lc(c.name).replace(/[^a-z]/g, '') === lc(r.name).replace(/[^a-z]/g, '')) || null;
    }
    const client = clientFor.get(r.college);
    const ck = compact(r.college);
    // An application at this college already? Same client, or a client spelled
    // like the sheet's college.
    const apps = cand ? cand.applications : [];
    const existing = apps.find((a) => client && a.requirement.client && a.requirement.client.id === client.id)
      || apps.find((a) => { const ak = compact(a.requirement.client ? a.requirement.client.name : ''); return ak && (ak.startsWith(ck) || ck.startsWith(ak)); })
      || null;
    plan.push({ r, cand, client, existing });
  }

  const report = {
    rows: rows.length,
    joinings: rows.filter((r) => r.status.joined).length,
    drops: rows.filter((r) => !r.status.joined).length,
    perRecruiter: {},
    candidates: { matched: plan.filter((p) => p.cand).length, created: plan.filter((p) => !p.cand).length },
    applications: { moveExisting: plan.filter((p) => p.existing).length, create: plan.filter((p) => !p.existing).length },
  };
  rows.filter((r) => r.status.joined).forEach((r) => {
    const k = `${r.seat} · ${rec(r).name}`;
    report.perRecruiter[k] = (report.perRecruiter[k] || 0) + 1;
  });
  const invoices = await prisma.invoice.findMany({
    where: { invoiceNumber: { in: rows.map((r) => r.invoiceNo).filter(Boolean) } },
    select: { id: true, invoiceNumber: true, candidateId: true, requirementId: true, candidate: { select: { name: true } } },
  });
  const invByNo = new Map(invoices.map((i) => [i.invoiceNumber, i]));

  if (!COMMIT) {
    console.log(JSON.stringify({
      DRY_RUN: true,
      report,
      seatsToday: seatNow.map((a) => `${a.position.code}: ${a.employee.name} ${a.fromDate} → ${a.toDate || 'now'}`),
      seatHistory: Object.fromEntries(Object.entries(history).map(([k, v]) => [k, v.map((x) => `${x.who.name} (${x.who.employeeCode}): ${x.from} → ${x.until || 'now'}  [${x.n} rows]`)])),
      clients: clientHow,
      rows: plan.map(({ r, cand, client, existing }) => `${r.line} ${r.name}${r.phoneBelongsTo ? ` [sheet phone is ${r.phoneBelongsTo}'s]` : ''} | ${r.seat} ${rec(r).name} / TL ${tlOf(r).name} | ${r.status.note} | cand: ${cand ? cand.name : 'NEW'} | ${existing ? `move app @ ${existing.requirement.client ? existing.requirement.client.name : '-'} / ${existing.requirement.title} (${existing.stage})` : `new app @ ${client ? client.name : 'NEW CLIENT'}`} | invoice ${r.invoiceNo}: ${invByNo.has(r.invoiceNo) ? `found (${invByNo.get(r.invoiceNo).candidate ? invByNo.get(r.invoiceNo).candidate.name : 'no candidate'})` : 'not found'}`),
    }, null, 1));
    await prisma.$disconnect();
    return;
  }

  // ================================ WRITE ========================================
  const done = { peopleUpdated: 0, seatSegments: 0, seatsCleared: 0, clientsCreated: 0, candidatesCreated: 0, candidatesFilled: 0, appsMoved: 0, appsCreated: 0, requirementsCreated: 0, invoicesLinked: 0, sharedInvoices: [] };

  // People: Education department; today's Team B recruiters report to today's TL.
  const currentTl = history[TL_SEAT].find((x) => !x.until).who;
  const currentRecruiters = SEATS.map((c) => (history[c].find((x) => !x.until) || {}).who).filter(Boolean);
  for (const e of people) {
    const data = {};
    if (e.department !== DEPT) data.department = DEPT;
    if (currentRecruiters.some((x) => x.id === e.id)) {
      if (e.reportingManagerId !== currentTl.id) data.reportingManagerId = currentTl.id;
      if (e.tl !== currentTl.name) data.tl = currentTl.name;
    }
    if (Object.keys(data).length) { await prisma.employee.update({ where: { id: e.id }, data }); done.peopleUpdated += 1; }
  }

  // Seats: replace EDU-6…10 / EDU-TL with the sheet's history; clear the seatings
  // the sheet contradicts.
  for (const code of [...SEATS, TL_SEAT]) {
    const pos = posByCode.get(code);
    await prisma.positionAssignment.deleteMany({ where: { positionId: pos.id } });
    for (const run of history[code]) {
      await prisma.positionAssignment.create({
        data: { positionId: pos.id, employeeId: run.who.id, fromDate: run.from, toDate: run.until, note: `From the Education Team B joinings sheet (${run.n} rows)` },
      });
      done.seatSegments += 1;
    }
  }
  for (const c of CLEAR_SEAT_OF) {
    const e = byCode.get(c.employeeCode);
    const pos = posByCode.get(c.code);
    if (e && pos) done.seatsCleared += (await prisma.positionAssignment.deleteMany({ where: { positionId: pos.id, employeeId: e.id } })).count;
  }

  // Requirement codes continue the REQ- series.
  const lastReq = await prisma.requirement.findMany({ where: { reqCode: { startsWith: 'REQ-' } }, select: { reqCode: true } });
  let seq = Math.max(0, ...lastReq.map((x) => Number(String(x.reqCode).slice(4)) || 0));

  for (const { r, cand: found, client: foundClient, existing } of plan) {
    const recruiter = rec(r);
    const tl = tlOf(r);
    const pos = posByCode.get(r.seat);

    // Candidate
    let cand = found;
    const fill = { name: r.name, phone: r.phone || null, education: r.qualification || null, specialization: r.branch || null };
    if (!cand) {
      cand = await prisma.candidate.create({ data: { ...fill, source: SOURCE, firstSource: SOURCE } });
      done.candidatesCreated += 1;
    } else {
      const blanks = {};
      Object.entries(fill).forEach(([k, v]) => { if (v && !cand[k]) blanks[k] = v; });
      if (Object.keys(blanks).length) { await prisma.candidate.update({ where: { id: cand.id }, data: blanks }); done.candidatesFilled += 1; }
    }

    // Client (only when no match at all)
    let client = foundClient;
    if (!client && !existing) {
      client = await prisma.client.create({ data: { name: r.college, ownerDepartment: DEPT, status: 'Active' } });
      clientFor.set(r.college, client);
      done.clientsCreated += 1;
    }

    // Requirement: the existing application's, else this college's faculty
    // requirement for the branch, else a new (closed) one.
    let requirementId = existing ? existing.requirement.id : null;
    let title = existing ? existing.requirement.title : null;
    if (!requirementId) {
      const branch = lc(r.branch) || 'cse';
      const reqs = await prisma.requirement.findMany({
        where: { clientId: client.id }, select: { id: true, title: true }, orderBy: { createdAt: 'desc' },
      });
      const hit = reqs.find((q) => lc(q.title).includes(branch) && /faculty|regular|professor/.test(lc(q.title)))
        || reqs.find((q) => lc(q.title).includes(branch));
      if (hit) { requirementId = hit.id; title = hit.title; } else {
        seq += 1;
        title = `Faculty — ${r.branch ? r.branch.toUpperCase() : 'CSE'}`;
        const made = await prisma.requirement.create({
          data: {
            title, clientId: client.id, department: DEPT, status: 'CLOSED', priority: 'Medium', openings: 1,
            reqCode: `REQ-${String(seq).padStart(4, '0')}`, description: `${title}. ${SOURCE}.`,
            tl: tl.name, tlId: login(tl), recruiterId: login(recruiter), positionCode: r.seat,
            createdAt: new Date(`${r.ivDate || r.joinDate}T09:00:00Z`),
          },
        });
        requirementId = made.id;
        done.requirementsCreated += 1;
      }
    }

    // Application
    const inv = invByNo.get(r.invoiceNo);
    const stage = r.status.joined ? 'JOINED' : 'REJECTED';
    const appData = {
      stage,
      interviewAt: r.ivDate ? new Date(`${r.ivDate}T10:00:00Z`) : null,
      interviewStatus: 'COMPLETED',
      offeredCtc: r.salary ? r.salary * 12 : null,
      offerNotes: r.salary ? `Salary as in the joinings sheet: ₹${r.salary.toLocaleString('en-IN')} per month` : null,
      joiningDate: r.joinDate,
      joiningStatus: r.status.joined ? 'Joined' : 'Dropped',
      joinedAt: r.status.joined ? new Date(`${r.joinDate}T09:00:00Z`) : null,
      ...(inv ? { billingStatus: 'Invoiced' } : {}),
    };
    let app;
    const already = existing || await prisma.application.findUnique({ where: { candidateId_requirementId: { candidateId: cand.id, requirementId } } });
    if (already) {
      app = await prisma.application.update({ where: { id: already.id }, data: appData });
      done.appsMoved += 1;
    } else {
      app = await prisma.application.create({
        data: { ...appData, candidateId: cand.id, requirementId, source: SOURCE, firstSource: SOURCE, createdAt: new Date(`${r.ivDate || r.joinDate}T09:00:00Z`) },
      });
      done.appsCreated += 1;
    }

    // Invoice: link it to the placement when it is this candidate's.
    if (inv) {
      if (inv.candidateId && inv.candidateId !== cand.id) {
        // One invoice covering several joinings (e.g. 1833 for St. Peter's).
        done.sharedInvoices.push(`${r.invoiceNo}: ${r.name} (invoice record names ${inv.candidate ? inv.candidate.name : 'another candidate'})`);
      } else {
        const data = {};
        if (!inv.candidateId) data.candidateId = cand.id;
        if (!inv.requirementId) data.requirementId = requirementId;
        if (Object.keys(data).length) { await prisma.invoice.update({ where: { id: inv.id }, data }); done.invoicesLinked += 1; }
      }
    }

    // One stage event and one completed follow-up (replaced on a re-run).
    const when = new Date(`${r.joinDate}T09:00:00Z`);
    const clientName = client ? client.name : (existing && existing.requirement.client ? existing.requirement.client.name : r.college);
    await prisma.applicationStageEvent.deleteMany({ where: { applicationId: app.id, actorName: IMPORTER } });
    await prisma.applicationStageEvent.create({
      data: {
        applicationId: app.id, candidateId: cand.id, fromStage: null, toStage: stage,
        action: r.status.joined ? 'Joined' : 'Did not join', comment: r.status.note,
        actorName: IMPORTER, actorRole: 'Recruiter',
        actorSide: r.status.joined ? 'Internal' : 'Candidate',
        reasonCategory: r.status.joined ? null : 'Did Not Join', reasonDetail: r.status.joined ? null : 'Dropped (joinings sheet)',
        actorPositionId: pos ? pos.id : null, actorPositionCode: r.seat,
        requirementId, requirementTitle: title, clientId: client ? client.id : null, clientName,
        createdAt: when,
      },
    });
    await prisma.applicationFollowUp.deleteMany({ where: { applicationId: app.id, createdByName: IMPORTER } });
    const notes = [
      `College: ${r.college}`, r.qualification && `Qualification: ${r.qualification} ${r.branch}`.trim(),
      r.ivDate && `Interview date: ${r.ivDate}`, r.joinDate && `Joined date: ${r.joinDate}`,
      r.salary && `Salary: ₹${r.salary.toLocaleString('en-IN')} per month`, r.invoiceNo && `Invoice no: ${r.invoiceNo}`,
      `Status: ${r.status.note}`,
      r.phoneBelongsTo && `The sheet gives this candidate the phone of ${r.phoneBelongsTo} — not copied.`,
    ].filter(Boolean).join('\n');
    await prisma.applicationFollowUp.create({
      data: {
        applicationId: app.id, candidateId: cand.id, requirementId,
        ownerUserId: login(recruiter), ownerName: recruiter.name, ownerRole: 'Recruiter',
        tlUserId: login(tl), tlName: tl.name,
        ownerPositionId: pos ? pos.id : null, ownerPositionCode: r.seat,
        lastContactedAt: when, contactMode: 'Call',
        purpose: 'Education Team B joining', notes, outcome: r.status.joined ? 'Joined' : 'Did not join',
        completedAt: new Date(`${r.joinDate}T18:00:00Z`), completedNote: SOURCE,
        createdByName: IMPORTER, createdAt: when,
      },
    });
  }

  await prisma.auditLog.create({
    data: { action: 'Education Team B joinings imported', entity: 'Import', entityId: path.basename(FILE), toValue: JSON.stringify({ report, done }).slice(0, 900) },
  });
  console.log(JSON.stringify({ COMMITTED: true, report, done }, null, 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e.message); await prisma.$disconnect(); process.exit(1); });
