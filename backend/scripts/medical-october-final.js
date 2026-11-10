#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// KEERTHANA'S TEAM - OCTOBER 2026 FINAL JOININGS (founder 2026-11-10: "keerthana team final joinings, import it carefully"; "total 12").
//
// The sheet (CSV): Name, Contact, Qualification, Specialization, Designation, Invoice Number, Experience, Interview Date, Joining
// Status, Joining Date (dd/mm/yyyy), Offered CTC, Clinet Name, Payment, Recruiter name, seat. Every row is MEDICAL (team lead
// Keerthana) - never Non IT Medical.
//
// TeamLink is made to say exactly these joinings for Medical in October:
//   MATCH     a row and a Medical joining in TeamLink are the same person at the same client (name without "Dr", the client's name):
//             the joining date is set to the sheet's when it differs
//   ADD       a row TeamLink does not have: added Joined - the client, a Medical requirement there with that designation (an
//             existing one, else a new CLOSED one with TL Keerthana), the candidate (by mobile when the sheet has one, else new),
//             the history row and a done follow-up naming the recruiter and Keerthana
//   DUPLICATE a second October Medical joining of a person the sheet has once, at the same client (e.g. "Dr . Divya" next to
//             "Dr.Divya"): merged into the matched one (undo for 7 days in Candidates > Duplicates > Merges)
//   NOT ON THE LIST  an October Medical joining that matches no row and duplicates nobody: listed only - the founder decides
//
//   node scripts/medical-october-final.js --file <csv>                                   DRY RUN
//   TL_ALLOW_REAL_APPLY=1 node scripts/medical-october-final.js --file <csv> --apply --really-real
// VACUUM backup first; idempotent (a second run finds everything matched).
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
if (APPLY && !(argv.includes('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1.');
  process.exit(2);
}
const FILE = val('--file');
if (!FILE || !fs.existsSync(FILE)) { console.error('Needs --file <csv>'); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
process.chdir(BACK);
require('dotenv').config({ path: path.join(BACK, '.env') });
const prisma = require('../src/db');
const W = require('../src/utils/workers');
const { nextRequirementCode } = require('../src/utils/requirementCode');
const { logAudit } = require('../src/utils/audit');

const DEPT = 'Medical';
const MONTH = '2026-10';
const MARK = 'import:medical-october-final-2026-11-10';
const ACTOR = { id: null, name: 'Medical October final list 2026-11-10' };
const one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const nameKey = (v) => one(v).toLowerCase().replace(/^dr\b\.?\s*/i, '').replace(/[^a-z]/g, '');
const ckey = (v) => one(v).toLowerCase().replace(/\(on[- ]?paper\)/g, '').replace(/[^a-z0-9]/g, '');
const titleCase = (s) => { const t = one(s).replace(/as{3,}/ig, 'Ass'); return t.length <= 4 ? t.toUpperCase() : t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()); };
const phone10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const ddmm = (v) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(one(v)); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const STOP = new Set(['health', 'clinic', 'institute', 'medical', 'sciences', 'science', 'research', 'center', 'centre', 'paper', 'hospital', 'hospitals', 'college', 'private', 'limited']);
const marks = (raw) => one(raw).toLowerCase().replace(/\(on[- ]?paper\)/g, '').split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const sameClient = (clientName, raw) => { const k = ckey(clientName); const m = marks(raw); return m.length > 0 && m.some((w) => k.includes(w)); };
const istDay = (v) => (v ? new Date(new Date(v).getTime() + 330 * 60000).toISOString().slice(0, 10) : null);

function parseCsv(text) {
  const out = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch; } else if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); out.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

(async () => {
  try {
    const raw = parseCsv(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')).filter((r) => r.some((c) => one(c)));
    const head = raw[0].map((h) => one(h).toLowerCase());
    const col = (...names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0);
    const C = { name: col('name'), phone: col('contact'), spec: col('specialization'), desig: col('designation'), status: col('joining status'), join: col('joining date'), ctc: col('offered ctc'), client: col('clinet name', 'client name'), rec: col('recruiter name') };
    const rows = raw.slice(1).map((r, i) => ({
      row: i + 2, name: one(r[C.name]), phone: phone10(r[C.phone]), spec: one(r[C.spec]), desig: one(r[C.desig]), status: one(r[C.status]), join: ddmm(r[C.join]),
      ctc: one(r[C.ctc]), clientRaw: one(r[C.client]), recruiter: one(r[C.rec]), seat: one(r[head.length - 1] || r[r.length - 1]),
    })).filter((r) => r.name);

    const users = await prisma.user.findMany({ select: { id: true, name: true, status: true } });
    const person = W.makeResolver(users);
    const tl = person(null, 'Gundala chandra Keerthana');
    const clients = await prisma.client.findMany({ select: { id: true, name: true, legalName: true } });
    // every Medical joining in TeamLink (any month: a row may sit in the wrong month)
    const apps = await prisma.application.findMany({
      where: { stage: { in: ['JOINED', 'HIRED'] }, requirement: { department: DEPT } },
      select: {
        id: true, candidateId: true, joiningDate: true, joinedAt: true,
        candidate: { select: { name: true, phone: true } },
        requirement: { select: { id: true, reqCode: true, title: true, clientId: true, client: { select: { name: true } } } },
        stageEvents: { where: { toStage: { in: ['JOINED', 'HIRED'] } }, select: { createdAt: true }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
    });
    const dayOf = (a) => (/^\d{4}-\d{2}-\d{2}/.test(String(a.joiningDate || '')) ? String(a.joiningDate).slice(0, 10) : istDay(a.joinedAt || (a.stageEvents[0] && a.stageEvents[0].createdAt)));
    apps.forEach((a) => { a.day = dayOf(a); a.key = nameKey(a.candidate && a.candidate.name); a.clientName = (a.requirement && a.requirement.client && a.requirement.client.name) || ''; });
    const octBefore = apps.filter((a) => a.day && a.day.startsWith(MONTH));

    // match: same name, same client; an October one first
    const used = new Set();
    const plan = rows.map((r) => {
      const k = nameKey(r.name);
      const cands = apps.filter((a) => !used.has(a.id) && a.key === k && sameClient(a.clientName, r.clientRaw));
      const m = cands.find((a) => a.day && a.day.startsWith(MONTH)) || cands[0] || null;
      if (m) used.add(m.id);
      return { r, m };
    });
    const extras = octBefore.filter((a) => !used.has(a.id));
    const dup = extras.map((a) => ({ a, of: plan.find((p) => p.m && p.m.key === a.key && p.m.requirement.clientId === a.requirement.clientId) })).filter((x) => x.of);
    const other = extras.filter((a) => !dup.find((x) => x.a.id === a.id));

    console.log(`${rows.length} row(s) in the list (Medical, October). TeamLink has ${octBefore.length} Medical joining(s) in October now.`);
    plan.forEach(({ r, m }) => {
      const what = m ? `MATCH ${m.requirement.reqCode || m.requirement.title} (${m.candidate.name}, ${m.clientName})${m.day !== r.join ? ` - joining date ${m.day || 'none'} -> ${r.join}` : ''}` : 'ADD (not in TeamLink)';
      console.log(`  row ${r.row}: ${r.name} | ${titleCase(r.desig)} — ${titleCase(r.spec)} | ${r.clientRaw.slice(0, 40)} | ${r.join} | ${r.recruiter} -> ${what}`);
    });
    dup.forEach(({ a, of }) => console.log(`  DUPLICATE: "${a.candidate.name}" ${a.requirement.reqCode || ''} (${a.day}) is the same person as row ${of.r.row} -> merged into it`));
    other.forEach((a) => console.log(`  NOT ON THE LIST: "${a.candidate.name}" ${a.requirement.reqCode || ''} ${a.clientName} joined ${a.day} - left as it is; tell me if it should go`));
    const after = rows.filter((r) => r.join && r.join.startsWith(MONTH)).length + other.length;
    console.log(`After: ${after} Medical joining(s) in October (the list's ${rows.filter((r) => r.join && r.join.startsWith(MONTH)).length}${other.length ? ` + ${other.length} not on the list` : ''}).`);
    if (!APPLY) { console.log('DRY RUN: nothing was changed.'); return; }

    const bakDir = path.join(os.homedir(), '.teamlink-backups', `medical-october-final-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(bakDir, { recursive: true });
    await prisma.$executeRawUnsafe(`VACUUM INTO '${path.join(bakDir, 'before.db').split(path.sep).join('/').replace(/'/g, "''")}'`);
    const MERGE = require('../src/utils/candidateMerge'); // eslint-disable-line global-require
    for (const { a, of } of dup) {
      const out = await MERGE.mergeCandidates({ masterId: of.m.candidateId, donorIds: [a.candidateId], user: ACTOR, kind: 'MERGE', reason: `The same doctor twice in October (${a.requirement.reqCode}); Keerthana's final list has them once (founder 2026-11-10)` });
      await prisma.$executeRawUnsafe('DELETE FROM "JoiningRecord" WHERE "applicationId" = ? AND NOT EXISTS (SELECT 1 FROM "Application" WHERE "id" = ?)', a.id, a.id).catch(() => 0);
      console.log(`  merged "${a.candidate.name}" into row ${of.r.row} (${out.mergeLogId || 'merge log'})`);
    }
    for (const { r, m } of plan) {
      if (m) {
        if (m.day !== r.join && r.join) {
          await prisma.application.update({ where: { id: m.id }, data: { joiningDate: r.join } });
          await logAudit({ userId: null, actorName: ACTOR.name, action: 'Joining date set from the final list', entity: 'Application', entityId: m.id, fromValue: m.day || '', toValue: r.join, reason: `Keerthana's October list row ${r.row}` });
        }
        continue; // eslint-disable-line no-continue
      }
      const client = clients.find((c) => ckey(c.name) === ckey(r.clientRaw) || ckey(c.legalName) === ckey(r.clientRaw)) || (() => { const n = clients.filter((c) => sameClient(c.name, r.clientRaw)); return n.length === 1 ? n[0] : null; })();
      if (!client) { console.log(`  row ${r.row}: NOT ADDED - no client matches "${r.clientRaw}"`); continue; } // eslint-disable-line no-continue
      const at = new Date(`${r.join}T10:00:00+05:30`);
      const rec = r.recruiter ? person(null, r.recruiter) : null;
      const title = `${titleCase(r.desig || 'Doctor')}${r.spec ? ` — ${titleCase(r.spec)}` : ''}`;
      let req = (await prisma.requirement.findMany({ where: { clientId: client.id, department: DEPT }, select: { id: true, title: true } })).find((q) => ckey(q.title) === ckey(title));
      if (!req) {
        req = await prisma.requirement.create({ data: { title, clientId: client.id, department: DEPT, specialisation: r.spec || null, status: 'CLOSED', priority: 'Medium', openings: 1, reqCode: await nextRequirementCode(), tlId: tl.userId || null, tl: tl.label, recruiterId: rec && rec.userId ? rec.userId : null, positionCode: r.seat || null, description: `${title}. Created from Keerthana's October final list (2026-11-10).`, createdAt: at } });
      }
      let cand = null;
      if (r.phone) cand = (await prisma.candidate.findMany({ where: { phone: { contains: r.phone } }, select: { id: true, phone: true } })).find((c) => phone10(c.phone) === r.phone) || null;
      if (!cand) cand = await prisma.candidate.create({ data: { name: r.name, phone: r.phone, source: 'Joinings sheet', firstSource: 'Joinings sheet', skills: r.spec || null, createdAt: at } });
      const existing = await prisma.application.findFirst({ where: { candidateId: cand.id, requirementId: req.id }, select: { id: true, stage: true } });
      const app = existing
        ? await prisma.application.update({ where: { id: existing.id }, data: { stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined' } })
        : await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, stage: 'JOINED', joiningDate: r.join, joiningStatus: 'Joined', ownerRecruiterId: rec && rec.userId ? rec.userId : null, source: 'Joinings sheet', createdAt: at } });
      await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, fromStage: existing ? existing.stage : null, toStage: 'JOINED', action: 'Joined (final list)', comment: `Joined ${r.join} at ${client.name} - Keerthana's October final list${r.ctc ? `, ${r.ctc}` : ''}.`, actorUserId: rec && rec.userId ? rec.userId : null, actorName: rec ? rec.label : r.recruiter || ACTOR.name, actorRole: 'Recruiter', createdAt: at } });
      await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: rec && rec.userId ? rec.userId : null, ownerName: rec ? rec.label : r.recruiter || null, ownerRole: 'Recruiter', tlUserId: tl.userId || null, tlName: tl.label, nextAction: 'Joined', completedAt: at, createdAt: at, notes: `Joined ${r.join} · seat ${r.seat || '-'} · ${MARK} row ${r.row}`, createdByName: ACTOR.name } });
      await logAudit({ userId: null, actorName: ACTOR.name, action: 'Joining added from the final list', entity: 'Application', entityId: app.id, toValue: `${r.name} · ${client.name} · ${r.join}`, reason: `Keerthana's October list row ${r.row}` });
      console.log(`  row ${r.row}: added ${r.name} (${client.name}, ${r.join})`);
    }
    console.log(`DONE. Backup (before this): ${bakDir}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1200)); process.exit(1); });
