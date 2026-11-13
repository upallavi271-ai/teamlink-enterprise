#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// MEDICAL JOININGS - KEERTHANA, NOVEMBER 2026 (founder 2026-11-12: "medical - keerthana november joining sheet idhi, so proper ga
// import cheyyu"; Joining sheet.csv).
//
// The sheet: Name | Contact | Qualification | Specialization | Designation | Invoice Number | Experience | Interview Date |
// Joining Status | Joining Date | Offered CTC | Clinet Name | Payment | Recruiter name. These are MEDICAL joinings (Keerthana's
// team), so every row goes on a MEDICAL requirement (department Medical) - Keerthana's numbers move.
//
// Unlike the Non IT sheet, most rows have NO phone number, so the candidate is matched by phone when there is one, else by name
// (normalised; an ambiguous name is NOT imported and is listed). The CTC is "per month": it is stored as a YEARLY figure
// (monthly x 12) on the application's offeredCtc, the same as marking Joined by hand. "On Roll" and "Joined" both mean Joined.
//
// Per row: the client (name / legal name / alias, "(On Paper)" ignored); a Medical requirement at that client with that designation
// (and speciality), else a new CLOSED one (TL Keerthana, the recruiter); the candidate by phone or name, else a new one; the
// application Joined on the joining day (owner = the recruiter's login when there is one), its history row and a done follow-up
// naming the recruiter and Keerthana. A row is NOT imported (and is listed) when: no client matches, the person already joined that
// client, the name is ambiguous, or the joining date is missing. Nothing is deleted, nothing is sent. Every imported row leaves a
// marker, so a second run changes nothing.
//
//   node scripts/import-med-joinings-keerthana-2026-11.js --file "Joining sheet.csv"                                   DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/import-med-joinings-keerthana-2026-11.js --file "Joining sheet.csv" --apply --really-real
//   ... --undo <manifest.json> --really-real      takes back exactly what an --apply made
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const UNDO = val('--undo');
if ((APPLY || UNDO) && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
const FILE = val('--file');
if (!UNDO && (!FILE || !fs.existsSync(FILE))) { console.error('Needs --file "<Joining sheet.csv>"'); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
const XLSX = require('xlsx');
const prisma = require('../src/db');
const W = require('../src/utils/workers');
const { nextRequirementCode } = require('../src/utils/requirementCode');
const { logAudit } = require('../src/utils/audit');

const DEPT = 'Medical';
const MARK = 'import:med-joinings-keerthana-2026-11';
const ACTOR = 'Medical joinings - Keerthana Nov 2026 (Joining sheet.csv)';
const TL_NAMES = ['Keerthana', 'Keerthi', 'Keertana'];
const one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const key = (v) => one(v).toLowerCase().replace(/\(on[- ]?paper\)/g, '').replace(/[^a-z0-9]/g, '');
const words = (v) => one(v).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
// a person's name, for matching: drop a leading Dr/Mr/Mrs/Ms and all punctuation
const nameKey = (v) => one(v).toLowerCase().replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').replace(/[^a-z0-9]/g, '');
const firstToken = (v) => (one(v).toLowerCase().replace(/^(dr|mr|mrs|ms|prof)\.?\s*/i, '').split(/[^a-z]+/).filter(Boolean)[0] || '');
const titleCase = (s) => { const t = one(s); return t.length <= 4 ? t.toUpperCase() : t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); };
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
// "03-11-2026" (day-month-year) -> 2026-11-03; also tolerates d/m/y and ISO
function isoDay(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const s = one(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; // day-month-year
}
// "20,000 per month" -> 240000 (yearly); "1,50,000 per month" -> 1800000; a plain number is taken as-is yearly if it already looks annual
function yearlyCtc(v) {
  const s = one(v).toLowerCase();
  const num = Number((s.match(/[\d,]+/) || [''])[0].replace(/,/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  if (/month|\/m\b|pm\b|p\.m/.test(s)) return Math.round(num * 12);
  if (/year|annum|\/a\b|pa\b|p\.a|lpa/.test(s)) return Math.round(num);
  return Math.round(num * 12); // the sheet's figures are monthly
}

async function undo(manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  await prisma.$transaction([
    prisma.applicationFollowUp.deleteMany({ where: { id: { in: m.followUps } } }),
    prisma.applicationStageEvent.deleteMany({ where: { id: { in: m.events } } }),
    prisma.application.deleteMany({ where: { id: { in: m.applications } } }),
    prisma.requirement.deleteMany({ where: { id: { in: m.requirements } } }),
    prisma.candidate.deleteMany({ where: { id: { in: m.candidates } } }),
  ]);
  console.log(`UNDONE: ${m.applications.length} application(s), ${m.requirements.length} requirement(s), ${m.candidates.length} candidate(s) taken back.`);
}

(async () => {
  try {
    if (UNDO) { await undo(UNDO); return; }
    const wb = XLSX.readFile(FILE, { cellDates: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map((r, i) => ({
      row: i + 2,
      name: one(r.Name || r['Candidate Name']),
      phone: phone10(r.Contact || r['Mobile Number']),
      qual: one(r.Qualification),
      spec: one(r.Specialization || r.Specialisation),
      desig: one(r.Designation || r.Desigination),
      invoice: one(r['Invoice Number']),
      exp: one(r.Experience),
      iv: isoDay(r['Interview Date']),
      jstatus: one(r['Joining Status']),
      join: isoDay(r['Joining Date']),
      ctcRaw: one(r['Offered CTC'] || r['Offered Salary']),
      clientRaw: one(r['Clinet Name'] || r['Client Name'] || r.Client),
      recruiter: one(r['Recruiter name'] || r['Recruiter Name']),
    })).filter((r) => r.name);

    const [clients, aliases, users] = await Promise.all([
      prisma.client.findMany({ select: { id: true, name: true, legalName: true } }),
      prisma.clientAlias.findMany({ select: { clientId: true, alias: true } }).catch(() => []),
      prisma.user.findMany({ select: { id: true, name: true, status: true } }),
    ]);
    const person = W.makeResolver(users);
    const byKey = new Map();
    const add = (k, c) => { if (!k) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(c.id); };
    clients.forEach((c) => { add(key(c.name), c); add(key(c.legalName), c); });
    aliases.forEach((a) => add(key(a.alias), { id: a.clientId }));
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const findClient = (raw) => {
      const hit = byKey.get(key(raw));
      if (hit && hit.size === 1) return clientById.get([...hit][0]);
      const w = words(raw.replace(/\(on[- ]?paper\)/i, ''));
      const near = clients.filter((c) => { const cw = words(c.name).join(' '); return w.filter((x) => cw.includes(x.slice(0, 5))).length >= Math.max(2, w.length - 1); });
      return near.length === 1 ? near[0] : null;
    };
    let tlUser = null;
    for (const nm of TL_NAMES) { const p = person(null, nm); if (p && p.userId) { tlUser = p; break; } }
    if (!tlUser) tlUser = { userId: null, label: 'Keerthana' };

    const plan = [];
    for (const r of rows) {
      const why = [];
      if (!r.join) why.push('no joining date');
      const client = r.clientRaw ? findClient(r.clientRaw) : null;
      if (!client) why.push(`no client matches "${r.clientRaw}"`);
      const rec = r.recruiter ? person(null, r.recruiter) : null;
      let cand = null; let req = null; let app = null; let done = false; let otherJoin = null; let ambiguous = false; let joinedApp = null;
      if (client) {
        // the candidate: by phone when there is one, else by name (normalised)
        let cands = [];
        if (r.phone) {
          cands = await prisma.candidate.findMany({ where: { OR: [{ phone: { contains: r.phone } }, { phone: { contains: `${r.phone.slice(0, 5)} ${r.phone.slice(5)}` } }] }, select: { id: true, name: true, phone: true } });
          cand = cands.find((c) => phone10(c.phone) === r.phone) || null;
        }
        if (!cand) {
          const ft = firstToken(r.name);
          const named = ft ? await prisma.candidate.findMany({ where: { name: { contains: ft } }, select: { id: true, name: true, phone: true } }) : [];
          const exact = named.filter((c) => nameKey(c.name) === nameKey(r.name));
          if (exact.length === 1) cand = exact[0];
          else if (exact.length > 1) { ambiguous = true; cand = null; }
        }
        if (cand) {
          const apps = await prisma.application.findMany({ where: { candidateId: cand.id }, select: { id: true, stage: true, requirementId: true, requirement: { select: { clientId: true, department: true, reqCode: true, title: true } } } });
          done = (await prisma.applicationFollowUp.count({ where: { candidateId: cand.id, notes: { contains: MARK } } })) > 0;
          const joinedHere = apps.find((a) => ['JOINED', 'HIRED'].includes(a.stage) && a.requirement && a.requirement.clientId === client.id);
          joinedApp = joinedHere || null;
          if (joinedHere && !done) otherJoin = `already Joined at this client on ${joinedHere.requirement.reqCode || joinedHere.requirement.title} (${joinedHere.requirement.department || 'no department'})`;
        }
        const title = `${titleCase(r.desig || r.spec || 'Doctor')}${r.desig && r.spec ? ` — ${titleCase(r.spec)}` : ''}`;
        const reqs = await prisma.requirement.findMany({ where: { clientId: client.id, department: DEPT }, select: { id: true, title: true, reqCode: true } });
        req = reqs.find((q) => key(q.title) === key(title)) || null;
        if (req && cand) app = await prisma.application.findFirst({ where: { candidateId: cand.id, requirementId: req.id }, select: { id: true, stage: true } });
        r.title = title;
      }
      if (ambiguous) why.push(`more than one candidate is named "${r.name}" - not imported, check by hand`);
      if (otherJoin) why.push(otherJoin);
      plan.push({ r, client, rec, cand, req, app, joinedApp, done, skip: why.length ? why : null });
    }

    console.log(`${rows.length} row(s) in ${path.basename(FILE)} - all go to ${DEPT} (team lead ${tlUser.label || 'Keerthana'}).`);
    plan.forEach((p) => {
      const r = p.r;
      const state = p.done ? 'ALREADY IMPORTED' : p.skip ? `NOT IMPORTED: ${p.skip.join('; ')}` : 'WILL IMPORT';
      console.log(`  row ${r.row}: ${r.name} | ${r.title || r.desig} | ${p.client ? p.client.name : r.clientRaw} | joined ${r.join || '?'} | CTC ${yearlyCtc(r.ctcRaw) ? `${yearlyCtc(r.ctcRaw).toLocaleString('en-IN')}/yr` : '?'} | recruiter ${p.rec ? p.rec.label : r.recruiter}${p.rec && p.rec.userId ? '' : ' (no login)'} | ${p.cand ? 'candidate exists' : 'new candidate'} | ${p.req ? `requirement ${p.req.reqCode}` : 'new Medical requirement'} -> ${state}`);
    });
    const todo = plan.filter((p) => !p.done && !p.skip);
    console.log(`${todo.length} to import, ${plan.filter((p) => p.done).length} already imported, ${plan.filter((p) => !p.done && p.skip).length} not imported (see the reasons).`);
    if (!APPLY) { console.log('DRY RUN: nothing was changed.'); return; }
    if (!todo.length) { console.log('Nothing to import.'); return; }

    const bakDir = path.join(os.homedir(), '.teamlink-backups', `import-med-joinings-keerthana-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(bakDir, 'before.db').split(path.sep).join('/').replace(/'/g, "''")}'`);
    const made = { candidates: [], requirements: [], applications: [], events: [], followUps: [] };
    const reqMade = new Map();
    for (const p of todo) {
      const r = p.r;
      const at = new Date(`${r.join}T10:00:00+05:30`);
      const ctc = yearlyCtc(r.ctcRaw);
      let cand = p.cand;
      if (!cand) {
        cand = await prisma.candidate.create({ data: { name: r.name, phone: r.phone || null, source: 'Joinings sheet', firstSource: 'Joinings sheet', skills: r.spec || null, createdAt: at } });
        made.candidates.push(cand.id);
      }
      let req = p.req || reqMade.get(`${p.client.id}|${key(r.title)}`);
      if (!req) {
        const code = await nextRequirementCode();
        req = await prisma.requirement.create({
          data: {
            title: r.title, clientId: p.client.id, department: DEPT, specialisation: r.spec || null, status: 'CLOSED', priority: 'Medium', openings: 1, reqCode: code,
            tlId: tlUser.userId || null, tl: tlUser.label || 'Keerthana', recruiterId: p.rec && p.rec.userId ? p.rec.userId : null,
            description: `${r.title}. Created by the Medical joinings import - Keerthana Nov 2026 (Joining sheet.csv).`, createdAt: at,
          },
        });
        made.requirements.push(req.id);
        reqMade.set(`${p.client.id}|${key(r.title)}`, req);
      }
      let app = p.app;
      if (app) {
        await prisma.application.update({ where: { id: app.id }, data: { stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined', rollStatus: r.jstatus || undefined, offeredCtc: ctc || undefined } });
      } else {
        app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined', rollStatus: r.jstatus || null, offeredCtc: ctc || null, ownerRecruiterId: p.rec && p.rec.userId ? p.rec.userId : null, source: 'Joinings sheet', createdAt: at } });
        made.applications.push(app.id);
      }
      const ev = await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, fromStage: p.app ? p.app.stage : null, toStage: 'JOINED', action: 'Joined (joinings sheet)', comment: `Joined ${r.join} at ${p.client.name} - Medical joinings sheet, Keerthana Nov 2026${r.ctcRaw ? `, offered ${r.ctcRaw}${ctc ? ` (= ${ctc.toLocaleString('en-IN')}/yr)` : ''}` : ''}${r.invoice ? `, invoice ${r.invoice}` : ''}.`, actorUserId: p.rec && p.rec.userId ? p.rec.userId : null, actorName: p.rec ? p.rec.label : (r.recruiter || ACTOR), actorRole: 'Recruiter', createdAt: at } });
      made.events.push(ev.id);
      const fu = await prisma.applicationFollowUp.create({
        data: {
          applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: p.rec && p.rec.userId ? p.rec.userId : null, ownerName: p.rec ? p.rec.label : r.recruiter || null, ownerRole: 'Recruiter',
          tlUserId: tlUser.userId || null, tlName: tlUser.label || 'Keerthana', nextAction: 'Joined', completedAt: at, createdAt: at,
          notes: `Joined ${r.join}${r.iv ? ` (interview ${r.iv})` : ''}${r.invoice ? ` · invoice ${r.invoice}` : ''}${r.jstatus ? ` · ${r.jstatus}` : ''} · ${MARK} row ${r.row}`, createdByName: ACTOR,
        },
      });
      made.followUps.push(fu.id);
      await logAudit({ userId: null, actorName: ACTOR, action: 'Joining imported (Medical sheet - Keerthana)', entity: 'Application', entityId: app.id, toValue: `${r.name} · ${p.client.name} · ${r.join}`, reason: `Joining sheet.csv row ${r.row}` });
    }
    // backfill the On roll / Off roll on rows already joined (so re-running fills the column for data imported before this field existed)
    let rollSet = 0;
    for (const p of plan) {
      const target = p.joinedApp || p.app;
      if (p.r.jstatus && target && target.id) { await prisma.application.update({ where: { id: target.id }, data: { rollStatus: p.r.jstatus } }).catch(() => {}); rollSet += 1; }
    }
    if (rollSet) console.log(`On roll / Off roll set on ${rollSet} application(s).`);
    const manifest = path.join(bakDir, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(made, null, 1));
    console.log(`DONE: ${todo.length} joining(s) imported under ${DEPT} (TL ${tlUser.label || 'Keerthana'}). Backup and undo manifest: ${bakDir}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1200)); process.exit(1); });
