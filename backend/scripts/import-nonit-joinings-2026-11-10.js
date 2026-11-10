#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// NON IT MEDICAL JOININGS (founder 2026-11-10: joinings.xlsx - "idhi import cheyyu"; "medical, non it medical - careful ga chudu";
// "non it medical - bhavana").
//
// The sheet: Department | Candidate Name | Mobile Number | Qualification | Specialization | Desigination | Client | Interview Date |
// Joining Date | Offered Salary | Recruiter Name | Position | Teamlead. Its Department says "medical", but every row's team lead is
// Bhavana and its seat "Non It-…": these are NON IT MEDICAL joinings. So, unlike the October importer (which takes the department
// from the client, and Nova is a Medical client), every row here goes on a Non IT Medical requirement - never a Medical one, so
// Keerthana's Medical numbers do not move.
//
// Per row: the client (name / old name / alias, "(On-Paper)" ignored); a Non IT Medical requirement at that client with that
// designation (and speciality), else a new CLOSED one (TL Bhavana, the recruiter, the seat); the candidate by mobile number, else a
// new one; the application Joined on the joining day (owner = the recruiter's login when there is one), its history row and a done
// follow-up naming the recruiter and Bhavana. A row is NOT imported (and is listed) when: no client matches, the person already
// joined that client on another requirement (maybe under Medical - a person, not a duplicate to make), or a date / phone is missing.
// Nothing is deleted, nothing is sent. Every imported row leaves a marker, so a second run changes nothing.
//
//   node scripts/import-nonit-joinings-2026-11-10.js --file <joinings.xlsx>                                  DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/import-nonit-joinings-2026-11-10.js --file <joinings.xlsx> --apply --really-real
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
if (!UNDO && (!FILE || !fs.existsSync(FILE))) { console.error('Needs --file <joinings.xlsx>'); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
const XLSX = require('xlsx');
const prisma = require('../src/db');
const W = require('../src/utils/workers');
const { nextRequirementCode } = require('../src/utils/requirementCode');
const { logAudit } = require('../src/utils/audit');

const DEPT = 'Non IT Medical';
const MARK = 'import:nonit-joinings-2026-11-10';
const ACTOR = 'Joinings sheet 2026-11-10 (Non IT Medical)';
const one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const key = (v) => one(v).toLowerCase().replace(/\(on[- ]?paper\)/g, '').replace(/[^a-z0-9]/g, '');
const words = (v) => one(v).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
// "Asssistant" (the sheet's typo) -> Assistant; a short speciality (OBGY, ENT) stays in capitals
const titleCase = (s) => {
  const t = one(s).replace(/as{3,}/ig, 'Ass');
  return t.length <= 4 ? t.toUpperCase() : t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
};
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
// "11/2/26" (month/day/year, as the sheet shows) -> 2026-11-02
function isoDay(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 330 * 60000).toISOString().slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(one(v));
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
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
    const wb = XLSX.readFile(FILE, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }).map((r, i) => ({
      row: i + 2, deptRaw: one(r.Department), name: one(r['Candidate Name']), phone: phone10(r['Mobile Number']), qual: one(r.Qualification),
      spec: one(r.Specialization), desig: one(r.Desigination || r.Designation), clientRaw: one(r.Client), iv: isoDay(r['Interview Date']),
      join: isoDay(r['Joining Date']), ctc: one(r['Offered Salary']), recruiter: one(r['Recruiter Name']), seat: one(r.Position), tl: one(r.Teamlead),
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
      // a typo in the sheet ("Medone Hospita Kompally"): the one client whose name has all of the sheet's long words but one
      const w = words(raw.replace(/\(on[- ]?paper\)/i, ''));
      const near = clients.filter((c) => { const cw = words(c.name).join(' '); return w.filter((x) => cw.includes(x.slice(0, 5))).length >= Math.max(2, w.length - 1); });
      return near.length === 1 ? near[0] : null;
    };
    const tlUser = person(null, 'Gandrathi Bhavana').userId ? person(null, 'Gandrathi Bhavana') : person(null, 'Bhavana');

    const plan = [];
    for (const r of rows) {
      const why = [];
      if (key(r.tl) && !/bhavana/i.test(r.tl)) why.push(`team lead is "${r.tl}", not Bhavana`);
      if (!r.join) why.push('no joining date');
      if (!r.phone) why.push('no mobile number');
      const client = r.clientRaw ? findClient(r.clientRaw) : null;
      if (!client) why.push(`no client matches "${r.clientRaw}"`);
      const rec = r.recruiter ? person(null, r.recruiter) : null;
      let cand = null; let req = null; let app = null; let done = false; let otherJoin = null;
      if (client && r.phone) {
        const cands = await prisma.candidate.findMany({ where: { OR: [{ phone: { contains: r.phone } }, { phone: { contains: `${r.phone.slice(0, 5)} ${r.phone.slice(5)}` } }] }, select: { id: true, name: true, phone: true } });
        cand = cands.find((c) => phone10(c.phone) === r.phone) || null;
        if (cand) {
          const apps = await prisma.application.findMany({ where: { candidateId: cand.id }, select: { id: true, stage: true, requirementId: true, requirement: { select: { clientId: true, department: true, reqCode: true, title: true } } } });
          done = (await prisma.applicationFollowUp.count({ where: { candidateId: cand.id, notes: { contains: MARK } } })) > 0;
          const joinedHere = apps.find((a) => ['JOINED', 'HIRED'].includes(a.stage) && a.requirement && a.requirement.clientId === client.id);
          if (joinedHere && !done) otherJoin = `already Joined at this client on ${joinedHere.requirement.reqCode || joinedHere.requirement.title} (${joinedHere.requirement.department || 'no department'})`;
        }
        const title = `${titleCase(r.desig || r.spec || 'Staff')}${r.desig && r.spec ? ` — ${titleCase(r.spec)}` : ''}`;
        const reqs = await prisma.requirement.findMany({ where: { clientId: client.id, department: DEPT }, select: { id: true, title: true, reqCode: true } });
        req = reqs.find((q) => key(q.title) === key(title)) || null;
        if (req && cand) app = await prisma.application.findFirst({ where: { candidateId: cand.id, requirementId: req.id }, select: { id: true, stage: true } });
        r.title = title;
      }
      if (otherJoin) why.push(otherJoin);
      plan.push({ r, client, rec, cand, req, app, done, skip: why.length ? why : null });
    }

    console.log(`${rows.length} row(s) in ${path.basename(FILE)} - all go to ${DEPT} (team lead Bhavana), never to Medical.`);
    plan.forEach((p) => {
      const r = p.r;
      const state = p.done ? 'ALREADY IMPORTED' : p.skip ? `NOT IMPORTED: ${p.skip.join('; ')}` : 'WILL IMPORT';
      console.log(`  row ${r.row}: ${r.name} | ${r.title || r.desig} | ${p.client ? p.client.name : r.clientRaw} | joined ${r.join || '?'} | recruiter ${p.rec ? p.rec.label : r.recruiter}${p.rec && p.rec.userId ? '' : ' (no login)'} | ${p.cand ? 'candidate exists' : 'new candidate'} | ${p.req ? `requirement ${p.req.reqCode}` : 'new Non IT Medical requirement'} -> ${state}`);
    });
    const todo = plan.filter((p) => !p.done && !p.skip);
    console.log(`${todo.length} to import, ${plan.filter((p) => p.done).length} already imported, ${plan.filter((p) => !p.done && p.skip).length} not imported (see the reasons).`);
    if (!APPLY) { console.log('DRY RUN: nothing was changed.'); return; }
    if (!todo.length) { console.log('Nothing to import.'); return; }

    const bakDir = path.join(os.homedir(), '.teamlink-backups', `import-nonit-joinings-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(bakDir, 'before.db').split(path.sep).join('/').replace(/'/g, "''")}'`);
    const made = { candidates: [], requirements: [], applications: [], events: [], followUps: [] };
    const reqMade = new Map();
    for (const p of todo) {
      const r = p.r;
      const at = new Date(`${r.join}T10:00:00+05:30`);
      let cand = p.cand;
      if (!cand) {
        cand = await prisma.candidate.create({ data: { name: r.name, phone: r.phone, source: 'Joinings sheet', firstSource: 'Joinings sheet', skills: r.spec || null, createdAt: at } });
        made.candidates.push(cand.id);
      }
      let req = p.req || reqMade.get(`${p.client.id}|${key(r.title)}`);
      if (!req) {
        const code = await nextRequirementCode();
        req = await prisma.requirement.create({
          data: {
            title: r.title, clientId: p.client.id, department: DEPT, specialisation: r.spec || null, status: 'CLOSED', priority: 'Medium', openings: 1, reqCode: code,
            tlId: tlUser.userId || null, tl: tlUser.label || 'Bhavana', recruiterId: p.rec && p.rec.userId ? p.rec.userId : null, positionCode: r.seat || null,
            description: `${r.title}. Created by the Non IT Medical joinings import 2026-11-10 (joinings.xlsx).`, createdAt: at,
          },
        });
        made.requirements.push(req.id);
        reqMade.set(`${p.client.id}|${key(r.title)}`, req);
      }
      let app = p.app;
      if (app) {
        await prisma.application.update({ where: { id: app.id }, data: { stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined' } });
      } else {
        app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined', ownerRecruiterId: p.rec && p.rec.userId ? p.rec.userId : null, source: 'Joinings sheet', createdAt: at } });
        made.applications.push(app.id);
      }
      const ev = await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, fromStage: p.app ? p.app.stage : null, toStage: 'JOINED', action: 'Joined (joinings sheet)', comment: `Joined ${r.join} at ${p.client.name} - Non IT Medical joinings sheet 2026-11-10${r.ctc ? `, offered ${r.ctc}` : ''}.`, actorUserId: p.rec && p.rec.userId ? p.rec.userId : null, actorName: p.rec ? p.rec.label : (r.recruiter || ACTOR), actorRole: 'Recruiter', createdAt: at } });
      made.events.push(ev.id);
      const fu = await prisma.applicationFollowUp.create({
        data: {
          applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: p.rec && p.rec.userId ? p.rec.userId : null, ownerName: p.rec ? p.rec.label : r.recruiter || null, ownerRole: 'Recruiter',
          tlUserId: tlUser.userId || null, tlName: tlUser.label || 'Bhavana', nextAction: 'Joined', completedAt: at, createdAt: at,
          notes: `Joined ${r.join}${r.iv ? ` (interview ${r.iv})` : ''} · seat ${r.seat || '-'} · ${MARK} row ${r.row}`, createdByName: ACTOR,
        },
      });
      made.followUps.push(fu.id);
      await logAudit({ userId: null, actorName: ACTOR, action: 'Joining imported (Non IT Medical sheet)', entity: 'Application', entityId: app.id, toValue: `${r.name} · ${p.client.name} · ${r.join}`, reason: `joinings.xlsx row ${r.row}` });
    }
    const manifest = path.join(bakDir, 'undo-manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(made, null, 1));
    console.log(`DONE: ${todo.length} joining(s) imported under ${DEPT}. Backup and undo manifest: ${bakDir}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1200)); process.exit(1); });
