// ---------------------------------------------------------------------------
// WHO CAN BE SOMEBODY'S REPORTING MANAGER (user, 2026-10-10).
//
// "A recruiter's reporting manager must be a team lead of THEIR OWN department."
//
//   STAFF (recruiter, BDE, HR staff, any employee)
//         -> the ACTIVE team leads (and senior team leads) of their own department, plus the
//            department's Manager / Assistant Manager where one sits in it.
//   LEAD  (a team lead / senior team lead)
//         -> the department's STL, else the Managers / Assistant Managers, else Admin / Super Admin.
//   MGMT  (Manager / Assistant Manager) -> Admin / Super Admin (and other Managers for an Asst Manager).
//   TOP   (Admin / Super Admin)          -> Admin / Super Admin.
//
// BDE staff therefore report to the BDE team lead (the department is "BDE"); BDE TL -> Manager / Admin.
// A leaver (Relieved / Exited / Exit Process / Terminated), a switched-off login and a test login are never
// offered. `cross: true` (the "other departments" switch, default OFF) also offers the team leads of
// every other department - for the odd case that really reports across (R&D staff under the HR TL).
//
//   await candidatesFor({ department, level, excludeId, cross })
//     -> { options:[{id,name,role,department,label,otherDept}], title, empty, single, level }
//   await problemFor({ department, level, id }, { managerId | managerName, field }, { cross })
//     -> a plain-words problem, or null when the pick is fine
//   levelOf({ designation, user })
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { canonicalDepartment } = require('./bdeDesk');

const NOT_WORKING = ['Relieved', 'Exited', 'Exit Process', 'Terminated', 'Inactive', 'Suspended'];
const TEST_ROW = /zztest|example\.test/i;
const canon = (d) => (canonicalDepartment(d) || '').toLowerCase();
const same = (a, b) => !!canon(a) && canon(a) === canon(b);
const up = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '_');

// What kind of lead is this person? (login roles first, then the designation.)
function kindOf(e) {
  const u = e.user || {};
  const roles = [u.atsRole, u.hrmsRole, u.role].map(up);
  const d = String(e.designation || '').trim();
  if (roles.includes('SUPER_ADMIN')) return 'SUPER_ADMIN';
  if (roles.includes('ADMIN')) return 'ADMIN';
  if (roles.includes('MANAGER') || /^manager$/i.test(d)) return 'MANAGER';
  if (roles.includes('ASSISTANT_MANAGER') || /^assistant manager$/i.test(d)) return 'ASSISTANT_MANAGER';
  if (roles.includes('STL') || /^(stl|senior team lead)$/i.test(d)) return 'STL';
  if (roles.includes('TL') || /^(tl|team lead|team leader)$/i.test(d)) return 'TL';
  return null;
}
function levelOf(e) {
  const k = kindOf(e || {});
  if (k === 'SUPER_ADMIN' || k === 'ADMIN') return 'TOP';
  if (k === 'MANAGER' || k === 'ASSISTANT_MANAGER') return 'MGMT';
  if (k === 'TL' || k === 'STL') return 'LEAD';
  return 'STAFF';
}
const LABEL = { TL: 'TL', STL: 'STL', MANAGER: 'Manager', ASSISTANT_MANAGER: 'Assistant Manager', ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin' };

async function workingLeads() {
  const rows = await prisma.employee.findMany({
    where: { employmentStatus: { notIn: NOT_WORKING } },
    select: {
      id: true, name: true, email: true, department: true, designation: true, employmentStatus: true,
      user: { select: { status: true, role: true, hrmsRole: true, atsRole: true } },
    },
    orderBy: { name: 'asc' },
  });
  return rows
    .filter((e) => !(e.user && ['Inactive', 'Suspended'].includes(e.user.status)))
    .filter((e) => !TEST_ROW.test(`${e.name} ${e.email || ''}`))
    .map((e) => ({ ...e, kind: kindOf(e) }))
    .filter((e) => e.kind);
}

const shape = (e, dept) => ({
  id: e.id, name: e.name, role: e.kind, department: e.department || null,
  otherDept: !!dept && !same(e.department, dept) && !['ADMIN', 'SUPER_ADMIN', 'MANAGER', 'ASSISTANT_MANAGER'].includes(e.kind),
  label: `${e.name} — ${[LABEL[e.kind], e.department].filter(Boolean).join(', ')}`,
});

// Pure: the options out of a list of working leads (so an import can load the leads ONCE).
function optionsFrom(leads, { department, level = 'STAFF', excludeId = null, cross = false } = {}) {
  const all = leads.filter((e) => e.id !== excludeId);
  const dept = String(department || '').trim();
  const inDept = (e) => same(e.department, dept);
  const kinds = (...k) => all.filter((e) => k.includes(e.kind));
  let list = []; let title = ''; let empty = '';
  if (level === 'STAFF') {
    if (!dept) return { options: [], title: '', empty: 'Pick a department first.', single: null, level };
    const leads = kinds('TL', 'STL').filter(inDept);
    const mgrs = kinds('MANAGER', 'ASSISTANT_MANAGER').filter(inDept);
    // The department's own head (an Admin / Super Admin sitting in it) also counts - Administration has no TL.
    const heads = kinds('ADMIN', 'SUPER_ADMIN').filter(inDept);
    list = [...leads, ...mgrs, ...heads];
    if (cross) list = [...list, ...kinds('TL', 'STL').filter((e) => !inDept(e))];
    const tlN = leads.filter((e) => e.kind === 'TL').length;
    title = leads.length ? `${dept}: ${tlN} team lead${tlN === 1 ? '' : 's'}${mgrs.length ? ` and ${mgrs.length} manager${mgrs.length === 1 ? '' : 's'}` : ''}`
      : ((mgrs.length + heads.length) ? `${dept}: ${mgrs.length + heads.length} to report to` : '');
    empty = `No team lead in ${dept} yet.`;
  } else if (level === 'LEAD') {
    const stls = kinds('STL').filter(inDept);
    list = [...stls, ...kinds('MANAGER', 'ASSISTANT_MANAGER'), ...kinds('ADMIN', 'SUPER_ADMIN')];
    title = `${list.length} to report to (manager or above)`;
    empty = 'No manager yet.';
  } else if (level === 'MGMT') {
    list = [...kinds('MANAGER'), ...kinds('ADMIN', 'SUPER_ADMIN')];
    title = `${list.length} to report to`;
    empty = 'No admin yet.';
  } else {
    list = kinds('ADMIN', 'SUPER_ADMIN');
    title = `${list.length} admin${list.length === 1 ? '' : 's'}`;
    empty = 'No other admin.';
  }
  const seen = new Set();
  const options = list.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))).map((e) => shape(e, dept));
  return { options, title, empty: options.length ? '' : empty, single: options.length === 1 ? options[0].id : null, level, department: dept };
}
async function candidatesFor(args = {}) {
  return optionsFrom(await workingLeads(), args);
}

// For imports: load the leads once, then ask synchronously.
//   const rl = await eligibility();  rl.problem({ department, designation, id }, managerId)  -> string | null
async function eligibility() {
  const leads = await workingLeads();
  return {
    problem(subject, managerId) {
      if (!managerId) return null;
      const level = subject.level || levelOf({ designation: subject.designation });
      if (!subject.department) return null; // nothing to compare with yet
      const set = optionsFrom(leads, { department: subject.department, level, excludeId: subject.id || null });
      if (set.options.some((o) => o.id === managerId)) return null;
      const dept = subject.department;
      if (!set.options.length) return `${set.empty || 'Nobody to report to yet.'}`;
      return level === 'STAFF' ? `That person is not a team lead (or manager) of ${dept}.` : 'That person is not a manager of the right level.';
    },
  };
}

// A plain-words problem with a chosen manager, or null.
//   subject = { department, level, id }   the person being given a manager
//   pick    = { managerId } or { managerName, kind: 'TL' | 'STL' }
async function problemFor(subject, pick, { cross = false } = {}) {
  const set = await candidatesFor({ department: subject.department, level: subject.level || 'STAFF', excludeId: subject.id, cross });
  let hit = null;
  if (pick.managerId) hit = set.options.find((o) => o.id === pick.managerId);
  else if (pick.managerName) {
    const n = String(pick.managerName).trim().toLowerCase();
    hit = set.options.find((o) => o.name.trim().toLowerCase() === n && (!pick.kind || o.role === pick.kind || (pick.kind === 'TL' && ['MANAGER', 'ASSISTANT_MANAGER'].includes(o.role))));
  }
  if (hit) return null;
  const dept = subject.department || 'their department';
  if (!set.options.length) return `${set.empty || 'Nobody to report to yet.'} Add one first${cross ? '' : ', or switch on "other departments"'}.`;
  const who = (subject.level || 'STAFF') === 'STAFF' ? `a team lead of ${dept}` : 'a manager of the right level';
  return `That is not ${who}. Pick ${who} from the list${cross ? '' : ' (or switch on "other departments" if they really report across)'}.`;
}

// Read-only: ACTIVE employees whose reporting manager / TL / STL is outside the rules above.
async function mismatches() {
  const emps = await prisma.employee.findMany({
    where: { employmentStatus: { in: ['Active', 'On Probation', 'Notice Period'] } },
    select: {
      id: true, name: true, employeeCode: true, department: true, designation: true, tl: true, stl: true, reportingManagerId: true,
      reportingManager: { select: { id: true, name: true, department: true, employmentStatus: true } },
      user: { select: { role: true, hrmsRole: true, atsRole: true, status: true } },
    },
    orderBy: { name: 'asc' },
  });
  const leads = await workingLeads();
  const byName = new Map();
  leads.forEach((l) => { const k = l.name.trim().toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(l); });
  const out = [];
  for (const e of emps) {
    if (TEST_ROW.test(e.name)) continue;
    const level = levelOf(e);
    const set = await candidatesFor({ department: e.department, level, excludeId: e.id });
    const ids = new Set(set.options.map((o) => o.id));
    const names = new Set(set.options.map((o) => o.name.trim().toLowerCase()));
    const suggestion = set.options.length === 1 ? set.options[0].name : (set.options.length ? `${set.options.length} to choose from` : 'nobody yet');
    const add = (field, who, whoDept, why) => out.push({
      employeeId: e.id, employee: e.name, code: e.employeeCode, department: e.department || '(none)', level, field,
      manager: who, managerDepartment: whoDept || '(unknown)', why, suggestion,
    });
    if (e.reportingManagerId) {
      if (!e.reportingManager || NOT_WORKING.includes(e.reportingManager.employmentStatus)) add('Reporting manager', e.reportingManager ? e.reportingManager.name : '(missing)', e.reportingManager && e.reportingManager.department, 'has left');
      else if (!ids.has(e.reportingManagerId)) add('Reporting manager', e.reportingManager.name, e.reportingManager.department, 'not a lead of this department');
    }
    for (const [field, val] of [['TL', e.tl], ['STL', e.stl]]) {
      if (!val || !String(val).trim()) continue;
      if (String(val).trim().toLowerCase() === e.name.trim().toLowerCase()) continue; // the top person names themselves
      const k = String(val).trim().toLowerCase();
      if (names.has(k)) continue;
      const found = byName.get(k);
      if (!found) { add(field, val, null, 'not a working team lead / manager (left, or free text)'); continue; }
      add(field, val, found[0].department, 'not a lead of this department');
    }
  }
  return out;
}

module.exports = { candidatesFor, optionsFrom, eligibility, problemFor, levelOf, kindOf, mismatches, NOT_WORKING };
