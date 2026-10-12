// ---------------------------------------------------------------------------
// WHO IS THE BDE, AND IN WHICH SEAT (user, 2026-10-09).
//
// "Role-wise display of the assigned BDE: name + POSITION — Vasavi V · BDE MED,
//  … · BDE EDU 1." Client.bdeOwner is a NAME; the position is the seat the
// person holds today (PositionAssignment.toDate = null), turned into plain words
// by utils/bdeDesk.js (BDE-EDU-1 -> "BDE EDU 1").
//
//   const dir = await bdeDirectory();
//   dir.infoFor('Vasavi V')  ->  { name, position: 'BDE MED', desk: 'Medical', label: 'vasavi v · BDE MED', ... }
//
// A BDE who holds no seat yet is still described: "BDE Manufacturing" when
// their scope department is a desk, plain "BDE" otherwise. Nothing is stored;
// this is read fresh (a handful of rows).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { parseBdeSeat, canonicalDepartment } = require('./bdeDesk');
const { hasLeft } = require('./positions');

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function labelOf(name, position) {
  return position ? `${name} · ${position}` : name;
}
// Somebody who has left (Relieved / Exited): never offered, never counted as a desk's BDE, but a
// client that still names them reads "Name (former BDE)" so it can be reassigned (user, 2026-10-10).
const formerLabel = (name) => `${name} (former BDE)`;

async function bdeDirectory() {
  const [seats, users] = await Promise.all([
    prisma.positionAssignment.findMany({
      where: { toDate: null },
      select: {
        position: { select: { code: true, name: true, team: true, kind: true } },
        employee: { select: { id: true, name: true, userId: true, employmentStatus: true } },
      },
    }).catch(() => []),
    prisma.user.findMany({
      where: { OR: [{ atsRole: { in: ['BDE', 'TL'] } }, { role: 'BDE' }] },
      select: {
        id: true, name: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true, status: true,
        employee: { select: { employmentStatus: true } },
      },
    }).catch(() => []),
  ]);

  const byName = new Map();
  const add = (info) => { const k = norm(info.name); if (k && !byName.has(k)) byName.set(k, info); };

  // 1. People who hold a BDE seat today — the position is the seat.
  seats.forEach((a) => {
    const p = parseBdeSeat(a.position);
    if (!p.isBde || !a.employee) return;
    // A tenure still open for somebody who has left (it is ended on exit; this is the belt and braces).
    if (hasLeft(a.employee.employmentStatus)) {
      add({
        name: a.employee.name, userId: a.employee.userId || null, employeeId: a.employee.id, seatCode: null,
        position: null, desk: p.desk, isTl: p.isTl, active: false, former: true, label: formerLabel(a.employee.name),
      });
      return;
    }
    add({
      name: a.employee.name, userId: a.employee.userId || null, employeeId: a.employee.id,
      seatCode: a.position.code, position: p.label, desk: p.desk, isTl: p.isTl,
      active: !/exit|relieved|terminat|resign/i.test(a.employee.employmentStatus || ''),
      label: labelOf(a.employee.name, p.label),
    });
  });

  // 2. BDE logins with no seat: describe them by their scope department.
  users.forEach((u) => {
    if (!u.name || byName.has(norm(u.name))) return;
    const depts = [...csv(u.atsScopeDepartments), u.atsDepartment].filter(Boolean);
    const isBdeLogin = u.atsRole === 'BDE' || depts.some((d) => canonicalDepartment(d) === 'BDE');
    if (!isBdeLogin) return;
    const desk = depts.map((d) => canonicalDepartment(d)).find((d) => d && d !== 'BDE') || null;
    const position = u.atsRole === 'TL' ? 'BDE TL' : (desk ? `BDE ${desk}` : 'BDE');
    // Their login may still be switched on, but if the person has left they are a FORMER BDE.
    if (u.employee && hasLeft(u.employee.employmentStatus)) {
      add({
        name: u.name, userId: u.id, employeeId: null, seatCode: null, position: null, desk, isTl: u.atsRole === 'TL',
        active: false, former: true, label: formerLabel(u.name),
      });
      return;
    }
    add({
      name: u.name, userId: u.id, employeeId: null, seatCode: null, position, desk, isTl: u.atsRole === 'TL',
      active: (u.status || 'Active') !== 'Inactive', label: labelOf(u.name, position),
    });
  });

  return {
    byName,
    // The person a Client.bdeOwner name points at, or null when it names
    // nobody we know (typed free text).
    infoFor(name) { return byName.get(norm(name)) || null; },
    // "Name · Position" for any stored name; the bare name when unknown.
    labelFor(name) {
      const i = byName.get(norm(name));
      return i ? i.label : (String(name || '').trim() || null);
    },
    positionFor(name) { const i = byName.get(norm(name)); return i ? i.position : null; },
    // The wording of the BDE pickers (GET /clients/owner-options): the BDE TL
    // reads "Name · BDE TL · all departments"; everybody else "Name · BDE MED".
    // An unknown name stays as it is.
    pickerLabelFor(name) {
      const i = byName.get(norm(name));
      if (!i) return String(name || '').trim() || null;
      if (i.former) return i.label;
      return i.isTl ? `${i.name} · BDE TL · all departments` : i.label;
    },
    // Every BDE who still works here (seat holders first), for the pickers. Leavers are not in it.
    all() { return [...byName.values()].filter((i) => !i.former); },
    // Has the person this name points at left the company?
    isFormer(name) { const i = byName.get(norm(name)); return !!(i && i.former); },
  };
}

// THE CASCADE RULE (user, 2026-10-09): a client's BDE works for the client's
// department — decided by the seat code (BDE-EDU-1 -> Education), with the same
// aliases as everywhere (Education / EDU, Medical / MED, Manufacturing / MFG).
// The BDE TL covers every department. Returns a plain-words problem, or null
// when the pair is fine — also when we cannot tell (a typed name that is not a
// known BDE, a BDE whose seat names no department, no department chosen yet).
function bdeDepartmentProblem(dir, bdeName, department, who = 'This BDE') {
  const name = String(bdeName || '').trim();
  const dept = String(department || '').trim();
  if (!name || !dept) return null;
  const info = dir.infoFor(name);
  if (!info || info.isTl || !info.desk) return null;
  if (canonicalDepartment(dept) === info.desk) return null;
  return `${who} ${name} (${info.position}) works for ${info.desk}, not ${dept}. Pick ${/^[aeiou]/i.test(dept) ? 'an' : 'a'} ${dept} BDE, or the BDE TL.`;
}

// A list of options that name a BDE by name alone -> "Name · Position". Only
// the shown label changes (value, count and order stay); a name the directory
// does not know keeps its label. `nameOf` says which text holds the name.
async function labelBdeOptions(options, nameOf = (o) => o.label) {
  if (!Array.isArray(options) || !options.length) return options;
  const dir = await bdeDirectory();
  options.forEach((o) => {
    const n = nameOf(o);
    if (n && dir.infoFor(n)) o.label = dir.pickerLabelFor(n);
  });
  return options;
}

module.exports = { bdeDirectory, norm, bdeDepartmentProblem, labelBdeOptions };
