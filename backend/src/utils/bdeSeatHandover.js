// ---------------------------------------------------------------------------
// THE BDE SEAT DECIDES THE BDE (founder 2026-11-17: "rajeshwari aney person, vasavi BDE-MED place lo vachindhi. thana login lo,
// ats lo em kanipinchatledhu, anni 0 ani chupisthunnai").
//
// Two things went wrong when a new person took a BDE desk seat (BDE-MED, BDE-MFG-2, BDE-EDU-1 ...):
//   1. Add Employee's Role dropdown was left on "Recruiter", so the login was an ATS RECRUITER - and a recruiter sees only the
//      jobs assigned to them, i.e. nothing. syncRoles(): anybody who sits in a BDE desk seat (not BDE-TL) and whose ATS role
//      is Recruiter / Employee / unset is made an ATS BDE. Audited. A role set to anything else (TL, Admin, None) is left alone.
//   2. The leaver's book stayed in the leaver's name: Client.bdeOwner / secondaryBde are typed names, Requirement.bdeId and
//      the open follow-ups point at the leaver's login. moveBooks(): once a BDE has LEFT (employment Exited / Relieved /
//      Terminated, or the login is no longer Active), what is still theirs - their clients, the live (not CLOSED) jobs naming
//      them as BDE, their open follow-ups - goes to the person sitting in the seat they held last. Each client move is
//      audited; the new holder gets one bell note with the counts. Nobody in that seat yet: nothing moves (the BDE TL sees
//      those clients anyway; utils/bdeSeats.js shows them as "Name (former BDE)"). Closed jobs and done follow-ups keep the
//      leaver's name: that was their work.
//
//   isBdeDeskSeat(code)  BDE-<anything> except BDE-TL
//   syncRoles()          -> { fixed: [{ name, seat, from }] }
//   moveBooks()          -> { moved: [{ from, to, seat, clients, requirements, followUps }] }
//   run()                both, in that order; hourly from utils/leaverHandover.js and soon() after a seat is given
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { LEFT } = require('./leftLogin');
const { logAudit } = require('./audit');

const isBdeDeskSeat = (code) => /^BDE-/i.test(String(code || '').trim()) && !/^BDE-TL\b/i.test(String(code || '').trim());
const same = (a, b) => !!String(a || '').trim() && String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// the ATS roles a BDE seat holder is moved off; anything else was set on purpose
const LOOSE = new Set(['', 'RECRUITER', 'EMPLOYEE']);
const KEEP_ROLE = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'ASSISTANT_MANAGER', 'STL', 'TL', 'HR'];

async function bdeSeats() {
  const rows = await prisma.position.findMany({ where: { code: { startsWith: 'BDE-' } }, select: { id: true, code: true } });
  return rows.filter((p) => isBdeDeskSeat(p.code));
}

// the people sitting in a BDE desk seat now, still working, with an Active login
async function currentHolders() {
  const seats = await bdeSeats();
  if (!seats.length) return [];
  const code = new Map(seats.map((s) => [s.id, s.code]));
  const rows = await prisma.positionAssignment.findMany({
    where: { positionId: { in: seats.map((s) => s.id) }, toDate: null },
    select: {
      positionId: true, fromDate: true,
      employee: { select: { id: true, name: true, employmentStatus: true, user: { select: { id: true, name: true, role: true, atsRole: true, status: true } } } },
    },
    orderBy: { fromDate: 'desc' },
  });
  return rows
    .filter((a) => a.employee && a.employee.user && !LEFT.includes(a.employee.employmentStatus) && a.employee.user.status === 'Active')
    .map((a) => ({ seat: code.get(a.positionId), positionId: a.positionId, fromDate: a.fromDate, user: a.employee.user }));
}

async function syncRoles() {
  const fixed = [];
  for (const h of await currentHolders()) {
    const u = h.user;
    if (u.atsRole === 'BDE' || !LOOSE.has(String(u.atsRole || '')) || KEEP_ROLE.includes(u.role)) continue; // eslint-disable-line no-continue
    const data = { atsRole: 'BDE', atsAccess: true };
    if (u.role === 'RECRUITER') data.role = 'BDE'; // what picking "BDE" on Add Employee would have stored
    // eslint-disable-next-line no-await-in-loop
    const n = await prisma.user.updateMany({ where: { id: u.id, atsRole: u.atsRole }, data });
    if (!n.count) continue; // eslint-disable-line no-continue
    fixed.push({ name: u.name, seat: h.seat, from: u.atsRole || '(none)' });
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: null, actorName: 'TeamLink', action: `ATS role set to BDE (sits in ${h.seat})`, entity: 'User', entityId: u.id,
      fromValue: u.atsRole || '(none)', toValue: 'BDE',
      reason: `${u.name} holds the BDE seat ${h.seat}; as ${u.atsRole ? `a ${u.atsRole}` : 'a login with no ATS role'} the ATS showed them nothing`,
    }).catch(() => {});
  }
  return { fixed };
}

async function moveBooks() {
  const moved = [];
  const holders = await currentHolders();
  if (!holders.length) return { moved };
  const seats = await bdeSeats();
  const code = new Map(seats.map((s) => [s.id, s.code]));
  // everybody who ever sat in a BDE desk seat and has left, with every BDE seat they held, the one they left last first
  // (vasavi v sat on BDE-2 for one day and on BDE-MED for two months, both from 23 Sep: the seat that ended last is hers)
  const past = await prisma.positionAssignment.findMany({
    where: { positionId: { in: seats.map((s) => s.id) } },
    select: { positionId: true, fromDate: true, toDate: true, employee: { select: { employmentStatus: true, user: { select: { id: true, name: true, status: true } } } } },
  });
  const ends = (a) => a.toDate || '9999-12-31';
  const byLeaver = new Map(); // userId -> { from, seats: [positionId ...] }
  past.sort((a, b) => ends(b).localeCompare(ends(a)) || String(b.fromDate).localeCompare(String(a.fromDate))).forEach((a) => {
    const u = a.employee && a.employee.user;
    if (!u || !(LEFT.includes(a.employee.employmentStatus) || u.status !== 'Active')) return;
    if (!byLeaver.has(u.id)) byLeaver.set(u.id, { from: u, seats: [] });
    const e = byLeaver.get(u.id);
    if (!e.seats.includes(a.positionId)) e.seats.push(a.positionId);
  });
  for (const { from, seats: held } of byLeaver.values()) {
    // the newest BDE holder of the latest of their seats that somebody sits in now
    let to = null; let positionId = null;
    for (const pid of held) {
      to = holders.filter((h) => h.positionId === pid && h.user.atsRole === 'BDE' && h.user.id !== from.id)
        .sort((a, b) => String(b.fromDate).localeCompare(String(a.fromDate)))[0] || null;
      if (to) { positionId = pid; break; }
    }
    if (!to) continue; // eslint-disable-line no-continue
    const nm = String(from.name || '').trim();
    // eslint-disable-next-line no-await-in-loop
    const clients = nm ? (await prisma.client.findMany({
      where: { OR: [{ bdeOwner: { contains: nm } }, { secondaryBde: { contains: nm } }] }, select: { id: true, bdeOwner: true, secondaryBde: true },
    })).filter((c) => same(c.bdeOwner, nm) || same(c.secondaryBde, nm)) : [];
    let nClients = 0;
    for (const c of clients) {
      const data = {};
      if (same(c.bdeOwner, nm)) data.bdeOwner = to.user.name;
      if (same(c.secondaryBde, nm)) data.secondaryBde = same(data.bdeOwner || c.bdeOwner, to.user.name) ? null : to.user.name;
      // only while it still reads as it did (two passes never fight)
      // eslint-disable-next-line no-await-in-loop
      const n = await prisma.client.updateMany({ where: { id: c.id, bdeOwner: c.bdeOwner, secondaryBde: c.secondaryBde }, data });
      if (!n.count) continue; // eslint-disable-line no-continue
      nClients += 1;
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: null, actorName: 'TeamLink', action: 'Client handed over (the BDE left)', entity: 'Client', entityId: c.id,
        fromValue: from.name, toValue: to.user.name, reason: `${to.user.name} holds ${to.seat} now`,
      }).catch(() => {});
    }
    // eslint-disable-next-line no-await-in-loop
    const reqs = await prisma.requirement.updateMany({ where: { bdeId: from.id, status: { not: 'CLOSED' } }, data: { bdeId: to.user.id } });
    // eslint-disable-next-line no-await-in-loop
    const fus = await prisma.applicationFollowUp.updateMany({ where: { ownerUserId: from.id, completedAt: null }, data: { ownerUserId: to.user.id, ownerName: to.user.name } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.applicationFollowUp.updateMany({ where: { bdeUserId: from.id, completedAt: null }, data: { bdeUserId: to.user.id, bdeName: to.user.name } });
    if (!nClients && !reqs.count && !fus.count) continue; // eslint-disable-line no-continue
    const row = { from: from.name, to: to.user.name, seat: to.seat || code.get(positionId), clients: nClients, requirements: reqs.count, followUps: fus.count };
    moved.push(row);
    // eslint-disable-next-line no-await-in-loop
    await logAudit({
      userId: null, actorName: 'TeamLink', action: `BDE book handed over on ${row.seat}`, entity: 'User', entityId: to.user.id,
      fromValue: from.name, toValue: to.user.name, reason: `${row.clients} client(s), ${row.requirements} live job(s), ${row.followUps} open follow-up(s)`,
    }).catch(() => {});
    try {
      // eslint-disable-next-line global-require, no-await-in-loop
      await require('./notify').notifyUsers([to.user.id], {
        title: `💼 ${from.name}'s clients are yours now`,
        message: `${from.name} has left ${row.seat}. ${row.clients} client(s)${row.requirements ? `, ${row.requirements} live job(s)` : ''}${row.followUps ? ` and ${row.followUps} open follow-up(s)` : ''} now name you. They are in your Clients and Requirements lists.`,
      });
    } catch { /* the bell is a courtesy */ }
  }
  return { moved };
}

let RUNNING = false;
async function run() {
  if (RUNNING) return { fixed: [], moved: [], skipped: 'already running' };
  RUNNING = true;
  try {
    const { fixed } = await syncRoles();
    const { moved } = await moveBooks();
    if (fixed.length) console.log(`[bde-seats] ATS role set to BDE: ${fixed.map((f) => `${f.name} (${f.seat})`).join(', ')}`); // eslint-disable-line no-console
    if (moved.length) console.log(`[bde-seats] ${moved.map((m) => `${m.from} -> ${m.to}: ${m.clients} clients, ${m.requirements} jobs, ${m.followUps} follow-ups`).join('; ')}`); // eslint-disable-line no-console
    return { fixed, moved };
  } finally { RUNNING = false; }
}
// after a seat is given (Add Employee, Positions -> Assign, Edit employee): a moment later, never in the request
function soon() {
  const t = setTimeout(() => { run().catch((e) => console.error('[bde-seats]', e.message)); }, 1500); // eslint-disable-line no-console
  if (t.unref) t.unref();
}

module.exports = {
  isBdeDeskSeat, syncRoles, moveBooks, run, soon, currentHolders,
};
