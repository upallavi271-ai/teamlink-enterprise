// ---------------------------------------------------------------------------
// ONE CLIENT MANAGER (BDE) PER DEPARTMENT  (user, 2026-10-12).
//
//   "All medical clients - vasavi, all edu clients - sailaja, all mfg clients - neeraja."
//
//   Medical        -> vasavi v        (HRMS TL500, seat BDE MED)
//   Education      -> Sailaja Bongu   (TL508,      seat BDE EDU 2)
//   Manufacturing  -> Neeraja Yaatam  (TL509,      seat BDE MFG)
//
// Every other department (IT, R&D, Administration, no department ...) is left
// exactly as it is.
//
// HOW A CLIENT'S BDE IS STORED (same as Reassign owner, routes/clients.js PUT):
//   Client.bdeOwner     the Owner BDE, as the person's NAME (User.name)
//   Client.secondaryBde the second BDE, a NAME
//   audit row           action 'Client updated', entity 'Client',
//                       toValue 'BDE: <old> -> <new>', plus a reason
// Nothing is created or deleted, no role / seat / scope is changed, nobody is
// notified (the script prints who loses how many clients so a person can tell them).
//
// SAFE BY DEFAULT
//   * No flag             DRY RUN. Reads only. Prints the table, writes nothing.
//   * --csv <file>        also writes one row per client for checking in Excel.
//   * --apply             backup copy of the database (VACUUM INTO, to
//                         ~/.teamlink-backups/assign-bde-by-dept-<stamp>/), ONE
//                         transaction, one audit row per changed client, an
//                         undo manifest (JSON), then an integrity check.
//   * --undo <manifest>   puts the previous owner / second BDE back, exactly
//                         (skips a client somebody changed since; --force-undo
//                         restores anyway).
//   * The real dev database (backend/prisma/dev.db, or any file named dev.db)
//     is refused for --apply / --undo unless BOTH --really-real AND the
//     environment variable TL_ALLOW_REAL_APPLY=1 are given.
//   * --db <file>         any SQLite file (default backend/prisma/dev.db): the
//                         same script runs on the live server's own database.
//
// Included clients: every status except Archived (Active, Paused, Inactive,
// Suspended, no status). Archived clients are listed in the CSV and skipped.
// A department is recognised only on an EXACT (case-blind) match of
// 'Medical' / 'Education' / 'Manufacturing'; other spellings are printed as questions.
//
//   node scripts/assign-bde-by-department.js [--db <file>] [--csv <file>]
//   node scripts/assign-bde-by-department.js --apply [--db <file>] [--manifest <file>]
//   node scripts/assign-bde-by-department.js --undo <manifest.json> [--db <file>]
//   (real dev.db, apply/undo:  TL_ALLOW_REAL_APPLY=1 node ... --apply --really-real)
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BACKEND = path.resolve(__dirname, '..');
const REAL_DB = path.join(BACKEND, 'prisma', 'dev.db');
const DECIDED_ON = '2026-10-12';

// The instruction. `code` is the HRMS employee id; `name` the User.name stored on clients.
const TARGETS = [
  { dept: 'Medical', exact: 'medical', name: 'vasavi v', code: 'TL500', seatWord: 'MED', seatText: 'BDE MED' },
  { dept: 'Education', exact: 'education', name: 'Sailaja Bongu', code: 'TL508', seatWord: 'EDU', seatText: 'BDE EDU 2' },
  { dept: 'Manufacturing', exact: 'manufacturing', name: 'Neeraja Yaatam', code: 'TL509', seatWord: 'MFG', seatText: 'BDE MFG' },
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const reasonFor = (t) => `Bulk assignment by department: ${t.dept} -> ${t.name}, instructed by the owner on ${DECIDED_ON}`;
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

function parseArgs(argv) {
  const a = { apply: false, undo: null, db: null, csv: null, manifest: null, reallyReal: false, forceUndo: false, codes: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const val = () => { i += 1; return argv[i]; };
    if (k === '--apply') a.apply = true;
    else if (k === '--undo') a.undo = val();
    else if (k === '--db') a.db = val();
    else if (k === '--csv') a.csv = val();
    else if (k === '--manifest') a.manifest = val();
    else if (k === '--really-real') a.reallyReal = true;
    else if (k === '--force-undo') a.forceUndo = true;
    else if (k === '--codes') a.codes = val();
    else if (k === '--help' || k === '-h') a.help = true;
    else { console.error(`Unknown option ${k}`); a.help = true; }
  }
  return a;
}

function sameFile(a, b) {
  try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); } catch { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
}
const looksReal = (file) => sameFile(file, REAL_DB) || path.basename(file).toLowerCase() === 'dev.db';

// ---- reading the people -----------------------------------------------------------------
async function resolvePeople(prisma, targets, hasLeft, parseBdeSeat) {
  const [emps, users] = await Promise.all([
    prisma.employee.findMany({ select: { id: true, name: true, employeeCode: true, employmentStatus: true, department: true, userId: true } }),
    prisma.user.findMany({ select: { id: true, name: true, email: true, status: true, role: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true } }),
  ]);
  const out = [];
  for (const t of targets) {
    const p = { ...t, problems: [], warnings: [], notes: [], employee: null, user: null, seat: null };
    const byCode = emps.filter((e) => String(e.employeeCode || '').trim().toUpperCase() === t.code.toUpperCase());
    const byName = emps.filter((e) => norm(e.name) === norm(t.name));
    const first = norm(t.name).split(' ')[0];
    const similar = emps.filter((e) => norm(e.name).includes(first) && !byCode.some((c) => c.id === e.id) && !byName.some((c) => c.id === e.id));
    if (byCode.length !== 1) p.problems.push(`employee id ${t.code}: found ${byCode.length} (need exactly 1)`);
    if (byName.length !== 1) p.problems.push(`employee named "${t.name}": found ${byName.length} (need exactly 1)${byName.length > 1 ? ` -> ${byName.map((e) => `${e.name} ${e.employeeCode} ${e.employmentStatus}`).join(' | ')}` : ''}`);
    if (byCode.length === 1 && byName.length === 1 && byCode[0].id !== byName[0].id) {
      p.problems.push(`id ${t.code} belongs to "${byCode[0].name}" but the name "${t.name}" is employee ${byName[0].employeeCode}: not the same person`);
    }
    const e = byCode.length === 1 ? byCode[0] : (byName.length === 1 ? byName[0] : null);
    p.employee = e;
    if (similar.length) p.notes.push(`other people with a similar name (NOT used): ${similar.map((s) => `${s.name} ${s.employeeCode} ${s.employmentStatus}`).join(' | ')}`);
    if (e) {
      if (hasLeft(e.employmentStatus)) p.problems.push(`${e.name} (${e.employeeCode}) is ${e.employmentStatus}, not an active employee`);
      else if (!/^active$/i.test(String(e.employmentStatus || 'Active'))) p.warnings.push(`employment status is "${e.employmentStatus}" (not "Active")`);
      const u = e.userId ? users.find((x) => x.id === e.userId) : null;
      if (!u) p.problems.push(`${e.name} has no login (Employee.userId is empty or points nowhere)`);
      else {
        p.user = u;
        if (!/^active$/i.test(String(u.status || ''))) p.problems.push(`login of ${e.name} is "${u.status}", not Active`);
        if (u.name !== t.name && norm(u.name) !== norm(t.name)) p.problems.push(`login name "${u.name}" differs from "${t.name}"`);
        const sameName = users.filter((x) => norm(x.name) === norm(u.name));
        if (sameName.length > 1) p.problems.push(`${sameName.length} logins carry the name "${u.name}" (clients name the BDE by NAME, so it would be ambiguous): ${sameName.map((x) => x.email).join(', ')}`);
        if (String(u.atsRole || '').toUpperCase() !== 'BDE') p.warnings.push(`login ATS role is "${u.atsRole || '(none)'}", not BDE (not changed by this script)`);
      }
      const seats = await prisma.positionAssignment.findMany({
        where: { employeeId: e.id, toDate: null }, select: { position: { select: { code: true, name: true, team: true } } },
      });
      const parsed = seats.map((s) => ({ code: s.position.code, ...parseBdeSeat(s.position) })).filter((s) => s.isBde);
      p.seat = parsed.length ? parsed.map((s) => `${s.code} (${s.label})`).join(', ') : null;
      const right = parsed.find((s) => !s.isTl && s.desk === t.dept);
      if (!parsed.length) p.warnings.push(`holds no BDE seat today (expected ${t.seatText})`);
      else if (!right) p.warnings.push(`BDE seat ${p.seat} does not name the ${t.dept} desk (expected ${t.seatText})`);
      else if (!new RegExp(`\\b${t.seatWord}\\b`, 'i').test(right.label)) p.warnings.push(`seat label "${right.label}" is not the expected ${t.seatText}`);
    }
    out.push(p);
  }
  return out;
}

// ---- planning ---------------------------------------------------------------------------
async function buildPlan(prisma, people, deps) {
  const { bdeDirectory, hasLeft, canonicalDepartment } = deps;
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, ownerDepartment: true, status: true, bdeOwner: true, secondaryBde: true, clientType: true },
    orderBy: { name: 'asc' },
  });
  const isArchived = (c) => /^archived$/i.test(String(c.status || '').trim());
  const deptSpellings = new Map();
  clients.forEach((c) => { const k = c.ownerDepartment === null ? '(none)' : JSON.stringify(c.ownerDepartment); deptSpellings.set(k, (deptSpellings.get(k) || 0) + 1); });

  const questions = [];
  const spellingRows = [...deptSpellings.entries()].map(([k, n]) => {
    const raw = k === '(none)' ? null : JSON.parse(k);
    const hit = raw === null ? null : people.find((p) => norm(raw) === p.exact);
    const looks = raw !== null && !hit ? ['Medical', 'Education', 'Manufacturing'].includes(canonicalDepartment(raw)) : false;
    if (looks) questions.push(`Department spelled "${raw}" (${n} client${n === 1 ? '' : 's'}) looks like ${canonicalDepartment(raw)} but is NOT an exact match: left alone. Include it?`);
    return { raw, n, mapped: hit ? hit.dept : null, looks };
  }).sort((a, b) => b.n - a.n);

  const [emps, users, dir] = await Promise.all([
    prisma.employee.findMany({ select: { name: true, employeeCode: true, employmentStatus: true, department: true } }),
    prisma.user.findMany({ select: { name: true, status: true, atsRole: true } }),
    bdeDirectory(),
  ]);
  const empBy = new Map(); emps.forEach((e) => { const k = norm(e.name); if (!empBy.has(k)) empBy.set(k, []); empBy.get(k).push(e); });
  const userBy = new Map(); users.forEach((u) => { const k = norm(u.name); if (!userBy.has(k)) userBy.set(k, []); userBy.get(k).push(u); });

  const describeOwner = (name, dept) => {
    const flags = [];
    const k = norm(name);
    const es = empBy.get(k) || [];
    const us = userBy.get(k) || [];
    const info = dir.infoFor(name);
    if (es.some((e) => hasLeft(e.employmentStatus)) && !es.some((e) => !hasLeft(e.employmentStatus))) flags.push(`EXITED/RELIEVED (${es[0].employmentStatus})`);
    else if (info && info.former) flags.push('EXITED/RELIEVED');
    if (us.length && us.every((u) => /^inactive$/i.test(String(u.status || '')))) flags.push('login inactive');
    if (!es.length && !us.length) flags.push('not a known person (typed text)');
    if (info && !info.isTl && info.desk && info.desk !== dept) flags.push(`own desk is ${info.desk} (${info.position})`);
    if (info && info.isTl) flags.push('BDE TL');
    if (us.length > 1) flags.push(`${us.length} logins with this name`);
    return flags;
  };

  const rows = [];
  const byDept = new Map(people.map((p) => [p.dept, { person: p, total: 0, archived: 0, included: 0, same: 0, change: 0, noOwner: 0, prev: new Map(), secondClear: [], secondKeep: new Map() }]));
  clients.forEach((c) => {
    const p = people.find((x) => c.ownerDepartment !== null && norm(c.ownerDepartment) === x.exact);
    if (!p) return;
    const d = byDept.get(p.dept);
    d.total += 1;
    const row = {
      id: c.id, name: c.name, department: p.dept, status: c.status || '', oldOwner: c.bdeOwner || '', oldSecond: c.secondaryBde || '',
      newOwner: p.name, newSecond: c.secondaryBde || '', change: false, note: '',
    };
    if (isArchived(c)) { d.archived += 1; row.newOwner = c.bdeOwner || ''; row.note = 'skipped: Archived'; rows.push(row); return; }
    d.included += 1;
    const cur = String(c.bdeOwner || '').trim();
    if (!cur) d.noOwner += 1;
    const second = String(c.secondaryBde || '').trim();
    if (second && norm(second) === norm(p.name)) { row.newSecond = ''; d.secondClear.push(c); row.note = 'second BDE was the same person: cleared'; }
    else if (second) { d.secondKeep.set(second, (d.secondKeep.get(second) || 0) + 1); }
    if (cur === p.name && row.newSecond === (c.secondaryBde || '')) { d.same += 1; row.note = row.note || 'already correct'; }
    else {
      row.change = true; d.change += 1;
      if (cur !== p.name && cur) d.prev.set(cur, (d.prev.get(cur) || 0) + 1);
    }
    rows.push(row);
  });
  // previous owners with flags
  byDept.forEach((d) => {
    d.prevList = [...d.prev.entries()].map(([name, n]) => ({ name, n, flags: describeOwner(name, d.person.dept) })).sort((a, b) => b.n - a.n);
  });
  // who loses how many (across all departments)
  const loses = new Map();
  rows.filter((r) => r.change && r.oldOwner && norm(r.oldOwner) !== norm(r.newOwner)).forEach((r) => {
    if (!loses.has(r.oldOwner)) loses.set(r.oldOwner, new Map());
    const m = loses.get(r.oldOwner); m.set(r.department, (m.get(r.department) || 0) + 1);
  });
  // clients the script will not touch, for the questions
  const untouched = clients.filter((c) => !people.some((x) => c.ownerDepartment !== null && norm(c.ownerDepartment) === x.exact));
  return { clients, rows, byDept, spellingRows, questions, loses, untouched, isArchived, dir, describeOwner };
}

// A fingerprint of everything that must NOT change.
function fingerprint(allClients) {
  const others = crypto.createHash('sha1');
  const owners = crypto.createHash('sha1');
  allClients.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).forEach((c) => {
    const { bdeOwner, secondaryBde, ...rest } = c;
    others.update(JSON.stringify(rest));
    owners.update(`${c.id}|${bdeOwner || ''}|${secondaryBde || ''}`);
  });
  return { others: others.digest('hex'), owners: owners.digest('hex'), count: allClients.length };
}
const ownerCounts = (list) => { const m = new Map(); list.forEach((c) => { const k = c.bdeOwner || '(no owner)'; m.set(k, (m.get(k) || 0) + 1); }); return m; };

// ---- printing ---------------------------------------------------------------------------
function printPeople(people) {
  console.log('THE THREE PEOPLE');
  people.forEach((p) => {
    const e = p.employee;
    console.log(`  ${pad(p.dept, 14)} -> ${pad(p.name, 16)} id ${p.code}: ${e ? `${e.name} | ${e.employmentStatus} | dept ${e.department}` : 'NOT FOUND'}`
      + ` | login ${p.user ? `${p.user.email} (${p.user.status}, ATS ${p.user.atsRole || '-'})` : 'NONE'} | seat ${p.seat || 'NONE'}`);
    p.problems.forEach((x) => console.log(`      PROBLEM: ${x}`));
    p.warnings.forEach((x) => console.log(`      warning: ${x}`));
    p.notes.forEach((x) => console.log(`      note: ${x}`));
  });
  console.log('');
}

function printPlan(plan, people) {
  console.log('SUMMARY (Archived clients are skipped; every other status is included)');
  console.log(`  ${pad('DEPARTMENT', 15)}${pad('NEW OWNER', 17)}${lpad('CLIENTS', 8)}${lpad('ARCHIVED', 9)}${lpad('INCLUDED', 9)}${lpad('ALREADY OK', 11)}${lpad('WILL CHANGE', 12)}${lpad('NO OWNER NOW', 13)}`);
  plan.byDept.forEach((d) => {
    console.log(`  ${pad(d.person.dept, 15)}${pad(d.person.name, 17)}${lpad(d.total, 8)}${lpad(d.archived, 9)}${lpad(d.included, 9)}${lpad(d.same, 11)}${lpad(d.change, 12)}${lpad(d.noOwner, 13)}`);
  });
  const tot = [...plan.byDept.values()].reduce((a, d) => ({ total: a.total + d.total, archived: a.archived + d.archived, included: a.included + d.included, same: a.same + d.same, change: a.change + d.change, noOwner: a.noOwner + d.noOwner }), { total: 0, archived: 0, included: 0, same: 0, change: 0, noOwner: 0 });
  console.log(`  ${pad('TOTAL', 32)}${lpad(tot.total, 8)}${lpad(tot.archived, 9)}${lpad(tot.included, 9)}${lpad(tot.same, 11)}${lpad(tot.change, 12)}${lpad(tot.noOwner, 13)}\n`);

  plan.byDept.forEach((d) => {
    console.log(`${d.person.dept.toUpperCase()} -> ${d.person.name}`);
    console.log(`  previous owners of the ${d.change} clients that change:`);
    if (d.noOwner) console.log(`    ${pad('(no owner today)', 28)}${lpad(d.noOwner, 5)}`);
    d.prevList.forEach((o) => console.log(`    ${pad(o.name, 28)}${lpad(o.n, 5)}  ${o.flags.map((f) => `[${f}]`).join(' ')}`));
    if (!d.noOwner && !d.prevList.length) console.log('    (none)');
    console.log(`  second BDE: ${d.secondClear.length} equal the new owner -> second BDE CLEARED (it would be the same person twice)`);
    if (d.secondKeep.size) console.log(`              kept as they are (different person): ${[...d.secondKeep.entries()].map(([n, c]) => `${n} x${c}`).join(', ')}`);
    else console.log('              no other second BDEs in this department');
    console.log('');
  });

  console.log('WHO LOSES CLIENTS (tell them; nobody is notified by the script)');
  if (!plan.loses.size) console.log('  (nobody: no client has an owner who would be replaced)');
  [...plan.loses.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).forEach(([name, m]) => {
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    console.log(`  ${pad(name, 28)}${lpad(total, 4)} client(s)  (${[...m.entries()].map(([k, v]) => `${k} ${v}`).join(', ')})  ${plan.dir.infoFor(name) ? plan.dir.infoFor(name).label : ''}`);
  });
  console.log('');
  console.log('THE NEW OWNERS WILL OWN');
  plan.byDept.forEach((d) => console.log(`  ${pad(d.person.name, 18)}${lpad(d.included, 4)} clients in ${d.person.dept}`));
  console.log('');

  console.log('OTHER BDEs ON THE SAME DESK (their client list stays, but see the note)');
  plan.byDept.forEach((d) => {
    const mates = plan.dir.all().filter((i) => !i.isTl && i.desk === d.person.dept && norm(i.name) !== norm(d.person.name));
    console.log(`  ${pad(d.person.dept, 15)}${mates.length ? mates.map((i) => i.label).join(', ') : '(nobody else)'}`);
  });
  const anyMate = [...plan.byDept.values()].some((d) => plan.dir.all().some((i) => !i.isTl && i.desk === d.person.dept && norm(i.name) !== norm(d.person.name)));
  if (anyMate) console.log('  NOTE: a desk BDE sees the whole desk in the Clients list, but their jobs / candidates / interviews cover only THEIR OWN clients');
  if (anyMate) console.log('        (named owner / second BDE) + the desk clients that have no BDE yet. After this change no desk client is unowned, so a');
  if (anyMate) console.log('        colleague on the same desk keeps the list but loses those jobs, unless made second BDE on clients.\n');
  const others = plan.untouched.filter((c) => c.bdeOwner || c.secondaryBde);
  console.log(`CLIENTS OF OTHER DEPARTMENTS THAT ALREADY HAVE A BDE (left exactly as they are): ${others.length}`);
  others.forEach((c) => console.log(`  ${pad(c.name.slice(0, 40), 42)}${pad(c.ownerDepartment || '(no dept)', 12)}owner: ${c.bdeOwner || '-'}  second: ${c.secondaryBde || '-'}  ${[...new Set([c.bdeOwner, c.secondaryBde].filter(Boolean))].map((n) => plan.describeOwner(n, c.ownerDepartment).concat(plan.dir.infoFor(n) ? [] : ['holds no BDE seat / not on the BDE desk list']).map((x) => `[${n}: ${x}]`).join(' ')).join(' ')}`));
  console.log('');
  console.log('DEPARTMENT SPELLINGS IN THE CLIENT LIST (Client.ownerDepartment)');
  plan.spellingRows.forEach((s) => console.log(`  ${pad(s.raw === null ? '(no department)' : `"${s.raw}"`, 22)}${lpad(s.n, 5)}  ${s.mapped ? `-> ${s.mapped} (exact match: included)` : s.looks ? '-> QUESTION (looks like a target department, not exact)' : 'left alone (not in the instruction)'}`));
  console.log('');
  const statuses = new Map(); plan.clients.forEach((c) => { const k = c.status || '(none)'; statuses.set(k, (statuses.get(k) || 0) + 1); });
  console.log(`CLIENT STATUSES (all departments): ${[...statuses.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}  -> Archived skipped, everything else included`);
  console.log('');
}

function writeCsv(file, rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['client id', 'client name', 'department', 'status', 'old owner', 'old second BDE', 'new owner', 'new second BDE', 'change', 'note'];
  const lines = [head.map(q).join(',')];
  rows.forEach((r) => lines.push([r.id, r.name, r.department, r.status, r.oldOwner, r.oldSecond, r.newOwner, r.newSecond, r.change ? 'yes' : 'no', r.note].map(q).join(',')));
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

// ---- writing ----------------------------------------------------------------------------
async function backupDb(prisma, dbFile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${path.basename(dbFile)}.before-assign-bde`);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const size = fs.statSync(dest).size;
  if (!size) throw new Error('the backup copy is empty');
  return { dest, size };
}

const auditText = (oldOwner, newOwner, oldSecond, newSecond) => {
  let t = `BDE: ${oldOwner || '—'} → ${newOwner || '—'}`;
  if ((oldSecond || '') !== (newSecond || '')) t += `; Secondary BDE: ${oldSecond || '—'} → ${newSecond || '—'}`;
  return t.slice(0, 1000);
};

async function writeChanges(prisma, items, { reasonOf, actor }) {
  // items: [{ id, from:{bdeOwner,secondaryBde}, to:{bdeOwner,secondaryBde}, dept }]
  await prisma.$transaction(async (tx) => {
    for (const it of items) {
      const where = { id: it.id, bdeOwner: it.from.bdeOwner || null, secondaryBde: it.from.secondaryBde || null };
      // eslint-disable-next-line no-await-in-loop
      const r = await tx.client.updateMany({ where, data: { bdeOwner: it.to.bdeOwner || null, secondaryBde: it.to.secondaryBde || null } });
      if (r.count !== 1) throw new Error(`client ${it.id} changed while the script ran (or is missing): nothing was written`);
      // eslint-disable-next-line no-await-in-loop
      await tx.auditLog.create({
        data: {
          userId: null, actorName: actor, action: 'Client updated', entity: 'Client', entityId: it.id,
          toValue: auditText(it.from.bdeOwner, it.to.bdeOwner, it.from.secondaryBde, it.to.secondaryBde),
          reason: reasonOf(it),
        },
      });
    }
  }, { maxWait: 30000, timeout: 180000 });
}

function checkIntegrity(before, after, plan, people) {
  const lines = [];
  let ok = true;
  const say = (good, text) => { if (!good) ok = false; lines.push(`  ${good ? 'OK  ' : 'FAIL'} ${text}`); };
  const isTarget = (c) => people.find((p) => c.ownerDepartment !== null && norm(c.ownerDepartment) === p.exact);
  say(after.length === before.length, `client count ${before.length} -> ${after.length}`);
  people.forEach((p) => {
    const mine = after.filter((c) => isTarget(c) === p && !plan.isArchived(c));
    const wrong = mine.filter((c) => c.bdeOwner !== p.name);
    say(!wrong.length, `${p.dept}: ${mine.length - wrong.length} of ${mine.length} clients now have ${p.name} as owner${wrong.length ? ` (${wrong.length} wrong)` : ''}`);
    const dupSecond = mine.filter((c) => c.secondaryBde && norm(c.secondaryBde) === norm(p.name));
    say(!dupSecond.length, `${p.dept}: no client has ${p.name} as both owner and second BDE`);
  });
  const nonB = before.filter((c) => !isTarget(c)); const nonA = after.filter((c) => !isTarget(c));
  const fb = fingerprint(nonB); const fa = fingerprint(nonA);
  say(fb.owners === fa.owners, `other-department clients (${nonB.length}): owner + second BDE identical before/after`);
  const cb = ownerCounts(nonB); const ca = ownerCounts(nonA);
  say([...cb.entries()].every(([k, v]) => ca.get(k) === v) && cb.size === ca.size, `other-department owner counts unchanged: ${[...cb.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const archB = before.filter((c) => isTarget(c) && plan.isArchived(c)); const archA = after.filter((c) => isTarget(c) && plan.isArchived(c));
  say(fingerprint(archB).owners === fingerprint(archA).owners, `Archived clients of the three departments untouched (${archB.length})`);
  say(fingerprint(before).others === fingerprint(after).others, 'every other column of every client (name, agreement, department, status ...) identical before/after');
  return { ok, lines };
}

async function fullClients(prisma) { return prisma.client.findMany(); }

// ---- main -------------------------------------------------------------------------------
async function run(argv) {
  const args = parseArgs(argv);
  if (args.help || (args.undo && args.apply)) {
    console.log('Usage: node scripts/assign-bde-by-department.js [--db <file>] [--csv <file>] [--apply [--manifest <file>]] [--undo <manifest.json>] [--really-real] [--force-undo] [--codes Medical=TL500,Education=TL508,Manufacturing=TL509]');
    console.log('Dry run by default. See the header of the script.');
    return 0;
  }
  const dbFile = path.resolve(args.db || REAL_DB);
  if (!fs.existsSync(dbFile)) { console.error(`Database file not found: ${dbFile}`); return 2; }
  const writing = args.apply || !!args.undo;
  const real = looksReal(dbFile);
  if (writing && real && !(args.reallyReal && process.env.TL_ALLOW_REAL_APPLY === '1')) {
    console.error(`REFUSED: ${dbFile} is the real database. To write to it give BOTH --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1.`);
    return 3;
  }
  process.env.DATABASE_URL = `file:${dbFile.split(path.sep).join('/')}`;
  // Required only now, so nothing touches a database on require and the URL above is the one used.
  const prisma = require('../src/db'); // eslint-disable-line global-require
  const { bdeDirectory } = require('../src/utils/bdeSeats'); // eslint-disable-line global-require
  const { canonicalDepartment, parseBdeSeat } = require('../src/utils/bdeDesk'); // eslint-disable-line global-require
  const { hasLeft } = require('../src/utils/positions'); // eslint-disable-line global-require

  const targets = TARGETS.map((t) => ({ ...t }));
  if (args.codes) {
    args.codes.split(',').forEach((pair) => {
      const [d, c] = pair.split('=').map((s) => s.trim());
      const t = targets.find((x) => norm(x.dept) === norm(d));
      if (t && c) t.code = c;
    });
  }

  console.log(`${args.undo ? '*** UNDO ***' : args.apply ? '*** APPLY ***' : '*** DRY RUN: nothing will be written ***'}`);
  console.log(`database: ${dbFile}${real ? '  (REAL dev database)' : ''}\n`);

  try {
    if (args.undo) return await undo(prisma, args, dbFile);

    const people = await resolvePeople(prisma, targets, hasLeft, parseBdeSeat);
    printPeople(people);
    const problems = people.flatMap((p) => p.problems.map((x) => `${p.dept}/${p.name}: ${x}`));
    if (problems.length) {
      console.log('REFUSED: the three people could not be resolved safely:');
      problems.forEach((x) => console.log(`  - ${x}`));
      return 4;
    }
    const plan = await buildPlan(prisma, people, { bdeDirectory, hasLeft, canonicalDepartment });
    printPlan(plan, people);

    // Other clients: do their jobs all sit in one of the three departments? (a question, never acted on)
    const reqRows = plan.untouched.length ? await prisma.requirement.findMany({ where: { clientId: { in: plan.untouched.map((c) => c.id) } }, select: { clientId: true, department: true } }) : [];
    const q = [...plan.questions];
    plan.untouched.forEach((c) => {
      const depts = [...new Set(reqRows.filter((r) => r.clientId === c.id).map((r) => String(r.department || '').trim()).filter(Boolean))];
      const hit = depts.map((d) => people.find((p) => norm(d) === p.exact)).filter(Boolean);
      if (depts.length && hit.length === depts.length) q.push(`Client "${c.name}" has department ${c.ownerDepartment === null ? '(none)' : `"${c.ownerDepartment}"`} but all its jobs are ${depts.join('/')}: left alone. Should it get that department's BDE too?`);
      else if (c.ownerDepartment === null) q.push(`Client "${c.name}" has NO department${c.clientType ? ` (type ${c.clientType})` : ''}${depts.length ? `, jobs in ${depts.join('/')}` : ''}: left alone.`);
    });
    console.log(`QUESTIONS / THINGS LEFT ALONE (${q.length})`);
    if (!q.length) console.log('  (none)');
    q.forEach((x) => console.log(`  - ${x}`));
    console.log('');
    const keptOther = plan.untouched.filter((c) => c.ownerDepartment !== null).reduce((m, c) => m.set(c.ownerDepartment, (m.get(c.ownerDepartment) || 0) + 1), new Map());
    console.log(`Not touched at all: ${plan.untouched.length} client(s) in ${[...keptOther.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || '-'}${plan.untouched.some((c) => c.ownerDepartment === null) ? `, no department ${plan.untouched.filter((c) => c.ownerDepartment === null).length}` : ''}\n`);

    if (args.csv) { writeCsv(args.csv, plan.rows); console.log(`CSV written: ${path.resolve(args.csv)} (${plan.rows.length} rows)\n`); }

    const items = plan.rows.filter((r) => r.change).map((r) => ({
      id: r.id, name: r.name, dept: r.department,
      from: { bdeOwner: r.oldOwner || null, secondaryBde: r.oldSecond || null },
      to: { bdeOwner: r.newOwner, secondaryBde: r.newSecond || null },
    }));
    if (!args.apply) {
      console.log(`DRY RUN: ${items.length} client(s) would change. Nothing was written.`);
      console.log('To apply:  add --apply (real dev.db also needs --really-real and TL_ALLOW_REAL_APPLY=1).');
      return 0;
    }

    // ---- APPLY ----
    if (!items.length) { console.log('Nothing to change.'); return 0; }
    const stamp = stampNow();
    const root = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(os.homedir(), '.teamlink-backups');
    const dir = path.join(root, `assign-bde-by-dept-${stamp}`);
    const bk = await backupDb(prisma, dbFile, dir);
    console.log(`Backup copy: ${bk.dest} (${(bk.size / 1048576).toFixed(1)} MB)`);
    const before = await fullClients(prisma);
    const startedAt = new Date();
    const people2 = people;
    const reasonOf = (it) => reasonFor(people2.find((p) => p.dept === it.dept));
    const manifestFile = path.resolve(args.manifest || path.join(dir, 'undo-manifest.json'));
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, JSON.stringify({
      kind: 'assign-bde-by-department', createdAt: startedAt.toISOString(), database: dbFile, backup: bk.dest,
      people: people.map((p) => ({ dept: p.dept, name: p.name, code: p.code })),
      entries: items.map((it) => ({ clientId: it.id, clientName: it.name, dept: it.dept, before: it.from, after: it.to })),
    }, null, 1), 'utf8');
    console.log(`Undo manifest written first: ${manifestFile}`);
    await writeChanges(prisma, items, { reasonOf, actor: 'Bulk assignment script (instructed by the owner)' });
    console.log(`Applied: ${items.length} client(s) changed in one transaction, ${items.length} audit row(s) written.`);
    console.log(`Undo manifest: ${manifestFile}\n`);

    const after = await fullClients(prisma);
    const planAfter = { isArchived: plan.isArchived };
    const chk = checkIntegrity(before, after, planAfter, people);
    const audits = await prisma.auditLog.count({ where: { entity: 'Client', action: 'Client updated', reason: { startsWith: 'Bulk assignment by department:' }, createdAt: { gte: new Date(startedAt.getTime() - 1000) } } });
    chk.lines.push(`  ${audits === items.length ? 'OK  ' : 'FAIL'} audit rows written ${audits} (expected ${items.length})`);
    if (audits !== items.length) chk.ok = false;
    console.log('INTEGRITY CHECK');
    chk.lines.forEach((l) => console.log(l));
    console.log(chk.ok ? '\nALL CHECKS PASSED.' : '\nSOME CHECKS FAILED: look above. The undo command puts everything back.');
    console.log(`Undo:  ${real ? 'TL_ALLOW_REAL_APPLY=1 ' : ''}node scripts/assign-bde-by-department.js --undo "${manifestFile}"${args.db ? ` --db "${args.db}"` : ''}${real ? ' --really-real' : ''}`);
    return chk.ok ? 0 : 5;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function undo(prisma, args, dbFile) {
  const m = JSON.parse(fs.readFileSync(path.resolve(args.undo), 'utf8'));
  if (m.kind !== 'assign-bde-by-department' || !Array.isArray(m.entries)) { console.error('That file is not an assign-bde-by-department manifest.'); return 2; }
  if (path.resolve(m.database).toLowerCase() !== dbFile.toLowerCase()) console.log(`note: the manifest was made on ${m.database}; undoing on ${dbFile}`);
  const ids = m.entries.map((e) => e.clientId);
  const now = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, bdeOwner: true, secondaryBde: true } });
  const nowBy = new Map(now.map((c) => [c.id, c]));
  const eq = (a, b) => (a || '') === (b || '');
  const todo = []; const skipped = [];
  m.entries.forEach((e) => {
    const c = nowBy.get(e.clientId);
    if (!c) { skipped.push(`${e.clientName}: client no longer exists`); return; }
    if (eq(c.bdeOwner, e.before.bdeOwner) && eq(c.secondaryBde, e.before.secondaryBde)) return; // already back
    const unchangedSince = eq(c.bdeOwner, e.after.bdeOwner) && eq(c.secondaryBde, e.after.secondaryBde);
    if (!unchangedSince && !args.forceUndo) { skipped.push(`${e.clientName}: changed since (now owner "${c.bdeOwner || ''}", second "${c.secondaryBde || ''}"): left alone (--force-undo to restore anyway)`); return; }
    todo.push({ id: e.clientId, name: e.clientName, dept: e.dept, from: { bdeOwner: c.bdeOwner, secondaryBde: c.secondaryBde }, to: { bdeOwner: e.before.bdeOwner || null, secondaryBde: e.before.secondaryBde || null } });
  });
  console.log(`manifest: ${m.entries.length} client(s); to restore: ${todo.length}; skipped: ${skipped.length}`);
  skipped.slice(0, 30).forEach((x) => console.log(`  skipped - ${x}`));
  if (!todo.length) return 0;
  const stamp = stampNow();
  const root = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(os.homedir(), '.teamlink-backups');
  const bk = await backupDb(prisma, dbFile, path.join(root, `assign-bde-by-dept-undo-${stamp}`));
  console.log(`Backup copy before the undo: ${bk.dest}`);
  const beforeAll = await fullClients(prisma);
  await writeChanges(prisma, todo, { reasonOf: () => `Undo of bulk assignment by department (${path.basename(args.undo)})`, actor: 'Bulk assignment script (undo)' });
  const afterAll = await fullClients(prisma);
  const touched = new Set(todo.map((t) => t.id));
  const idOf = (c) => c.id;
  const restoredOk = todo.every((t) => { const c = afterAll.find((x) => idOf(x) === t.id); return c && eq(c.bdeOwner, t.to.bdeOwner) && eq(c.secondaryBde, t.to.secondaryBde); });
  const rest = (list) => fingerprint(list.filter((c) => !touched.has(c.id)));
  console.log(`Restored ${todo.length} client(s) in one transaction.`);
  console.log(`  ${restoredOk ? 'OK  ' : 'FAIL'} every restored client has its previous owner / second BDE again`);
  console.log(`  ${rest(beforeAll).owners === rest(afterAll).owners && rest(beforeAll).others === rest(afterAll).others ? 'OK  ' : 'FAIL'} all other clients untouched`);
  return restoredOk ? 0 : 5;
}

module.exports = { run, TARGETS, resolvePeople, buildPlan, checkIntegrity, parseArgs };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => { console.error('FAILED:', e && e.message ? e.message : e); process.exit(1); });
}
