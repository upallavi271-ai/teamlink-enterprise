// ---------------------------------------------------------------------------
// /api/ats-daily — the Recruiter daily report (spec C2), "Who has pending
// work" (ATS change list §13) and the daily-report e-mail setting.
//
//   GET  /month?month=YYYY-MM&person=&team=&department=   month table
//   GET  /day?day=YYYY-MM-DD&person=&team=&department=     that day's work
//   GET  /export?view=month|day&format=csv|xlsx|pdf&…      exactly what is shown
//   GET  /pending-work?department=                         TL / STL / Manager / Admin
//   GET  /mail-settings          PUT /mail-settings (Super Admin / Admin)
//   GET  /mail-preview?kind=tl|manager                     the e-mail, as text
//
// SCOPE IS ENFORCED HERE (utils/dailyReport.js): a Recruiter / BDE / HR login
// gets only their own work whatever the URL says; a TL their team; an STL /
// Manager their departments; Super Admin / Admin everything.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const { atsScopeOf } = require('../utils/scope');
const DR = require('../utils/dailyReport');
const MAIL = require('../utils/dailyReportMail');
const { toCsv, toXlsx, toPdf } = require('../utils/tabularExport');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));

const guarded = (fn) => async (req, res, next) => {
  try { return await fn(req, res); } catch (err) { return next(err); }
};

router.get('/month', guarded(async (req, res) => {
  const out = await DR.monthReport(req.user, req.query);
  return res.status(out.status).json(out.body);
}));

router.get('/day', guarded(async (req, res) => {
  const out = await DR.dayReport(req.user, req.query);
  return res.status(out.status).json(out.body);
}));

// EXPORT — the same rows the screen shows (same filters, same scope). Anyone
// may export their OWN work; exporting other people's needs the ATS Reports
// export permission (Manager / Admin / leads per the role matrix).
const dash = (v) => (v === null || v === undefined ? '—' : v);
router.get('/export', guarded(async (req, res) => {
  const acc = DR.access(req.user);
  if (!acc.ok) return res.status(403).json({ error: acc.error });
  if (!acc.selfOnly && !(await can(req.user, null, 'reports', 'ATS Reports', 'export'))) {
    return res.status(403).json({ error: 'Your role can look at this report but not download it.' });
  }
  const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'csv';
  const isDay = req.query.view === 'day';
  const out = isDay ? await DR.dayReport(req.user, req.query) : await DR.monthReport(req.user, req.query);
  if (out.status !== 200) return res.status(out.status).json(out.body);
  const b = out.body;
  const labelOf = (k) => (DR.METRICS.find((m) => m.key === k) || {}).label || k;
  let headers;
  let rows;
  let title;
  if (isDay) {
    headers = ['Time', 'Person', 'What', 'Candidate', 'Job', 'Client', 'Detail'];
    rows = b.rows.map((r) => [
      r.timeKnown ? new Date(r.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—',
      r.person, `${r.what}${r.imported ? ' (imported)' : ''}`, r.candidate || '', r.job || '', r.client || '', r.detail || '',
    ]);
    title = `Daily report — ${b.day}`;
  } else {
    headers = ['Date', ...DR.COLUMN_KEYS.map(labelOf)];
    rows = b.days.map((d) => [d.date, ...DR.COLUMN_KEYS.map((k) => dash(d[k]))]);
    rows.push(['Total', ...DR.COLUMN_KEYS.map((k) => dash(b.totals[k]))]);
    title = `Daily report — ${b.month}`;
  }
  const subtitle = `${b.scope} · exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
  const base = `daily-report-${isDay ? b.day : b.month}`;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    return res.send(`﻿${toCsv(headers, rows)}`);
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(toXlsx(headers, rows, 'Daily report'));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
  return res.send(toPdf(headers, rows, { title, subtitle }));
}));

router.get('/pending-work', guarded(async (req, res) => {
  const out = await DR.pendingWork(req.user, req.query);
  return res.status(out.status).json(out.body);
}));

// --- the 7 PM TL / weekly Manager e-mail (OFF by default) -------------------
const mailAdmin = (user) => atsScopeOf(user).global === true; // Super Admin / Admin

router.get('/mail-settings', guarded(async (req, res) => {
  const acc = DR.access(req.user);
  if (!acc.ok || acc.selfOnly) return res.status(403).json({ error: 'Only team leads, managers and admins see the e-mail setting.' });
  return res.json({ ...MAIL.publicSettings(await MAIL.loadSettings()), canEdit: mailAdmin(req.user) });
}));

router.put('/mail-settings', guarded(async (req, res) => {
  if (!mailAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can switch the report e-mails on or off.' });
  const out = await MAIL.saveSettings(req.user, req.body || {});
  if (out.error) return res.status(400).json({ error: out.error });
  return res.json({ ...out.settings, canEdit: true });
}));

// What the e-mail would say, built for the caller (nothing is sent).
router.get('/mail-preview', guarded(async (req, res) => {
  const acc = DR.access(req.user);
  if (!acc.ok || acc.selfOnly) return res.status(403).json({ error: 'Only team leads, managers and admins see the e-mail preview.' });
  const kind = req.query.kind === 'manager' ? 'manager' : 'tl';
  const mail = await MAIL.buildMail({ id: req.user.id, name: req.user.name }, kind);
  if (!mail) return res.status(400).json({ error: 'Could not build the e-mail for your login.' });
  return res.json({ ...mail, sent: false });
}));

// ---------------------------------------------------------------------------
// DEPARTMENTS & TEAMS (ATS change list §13) — the Admin screen's read: which
// departments each TL / STL looks after, which department and seat each
// recruiter sits in, the empty seats, and the history of who was where.
//
// The WRITES are the existing, audited ones (nothing new to keep in step):
//   give a TL / STL departments  PUT  /api/employees/management/:id/scope
//   move a recruiter             POST /api/employees/:id/transfer  (the login's
//                                ATS area follows) + POST /api/positions/:seat/assign
//                                (the old seat's tenure ends the day before —
//                                utils/positionScope.js: seats are permanent)
// History = those audit rows + the seat tenures (PositionAssignment).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const isTest = (u) => !!u && /zztest|example\.test/i.test(`${u.name || ''} ${u.email || ''}`);
const csvList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

router.get('/org', guarded(async (req, res) => {
  if (!mailAdmin(req.user)) return res.status(403).json({ error: 'Only a Super Admin or Admin can change departments and teams.' });
  const viewerIsTest = isTest(req.user);
  const [users, departments, seats, audits] = await Promise.all([
    prisma.user.findMany({
      where: { atsRole: { in: ['TL', 'STL', 'RECRUITER'] }, status: 'Active' },
      select: {
        id: true, name: true, email: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true,
        employee: {
          select: {
            id: true, department: true, team: true, employmentStatus: true,
            positionAssignments: { where: { toDate: null }, select: { fromDate: true, position: { select: { id: true, code: true, department: true, team: true, kind: true } } } },
          },
        },
      },
      orderBy: { name: 'asc' },
    }),
    // Recruiting departments only: those with jobs (an HR / Accounts department is not an ATS area).
    prisma.requirement.groupBy({ by: ['department'], _count: { _all: true } }),
    prisma.position.findMany({
      where: { active: true, kind: { in: ['RECRUITER', 'TL', 'STL'] } },
      select: {
        id: true, code: true, department: true, team: true, kind: true,
        assignments: { where: { toDate: null }, select: { employee: { select: { name: true, employmentStatus: true } } } },
      },
      orderBy: { code: 'asc' },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { action: 'Data scope changed' },
          { action: { startsWith: 'Employee transferred' } },
          { action: 'Login scope followed transfer' },
          { entity: 'PositionAssignment' },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        action: true, entity: true, entityId: true, fromValue: true, toValue: true, createdAt: true, actorName: true, user: { select: { name: true } },
      },
    }),
  ]);
  const people = users.filter((u) => viewerIsTest || !isTest(u));
  const LEFT = ['Relieved', 'Exited', 'Exit Process'];
  const seatOf = (u) => {
    const a = u.employee && (u.employee.positionAssignments || [])[0];
    return a && a.position ? { ...a.position, since: a.fromDate } : null;
  };
  // Names for the audit rows (entityId is a User / Employee / tenure id).
  const byUser = new Map(users.map((u) => [u.id, u.name]));
  const byEmp = new Map(users.filter((u) => u.employee).map((u) => [u.employee.id, u.name]));
  const history = audits
    .map((a) => ({
      at: a.createdAt,
      who: byUser.get(a.entityId) || byEmp.get(a.entityId) || (a.entity === 'PositionAssignment' ? (a.toValue || null) : null),
      what: a.action,
      from: a.fromValue || null,
      to: a.toValue || null,
      by: a.actorName || (a.user && a.user.name) || null,
    }))
    .filter((h) => viewerIsTest || !/zztest|example\.test/i.test(`${h.who || ''} ${h.what} ${h.to || ''} ${h.from || ''}`));
  const deptNames = [...new Set([
    ...departments.map((d) => d.department),
    ...seats.map((p) => p.department),
  ].filter(Boolean))].sort();
  return res.json({
    departments: deptNames,
    leads: people.filter((u) => ['TL', 'STL'].includes(u.atsRole)).map((u) => ({
      userId: u.id,
      employeeId: u.employee ? u.employee.id : null,
      name: u.name,
      role: u.atsRole,
      homeDepartment: (u.employee && u.employee.department) || u.atsDepartment || null,
      departments: csvList(u.atsScopeDepartments),
      seat: seatOf(u),
    })),
    recruiters: people.filter((u) => u.atsRole === 'RECRUITER').map((u) => ({
      userId: u.id,
      employeeId: u.employee ? u.employee.id : null,
      name: u.name,
      department: (u.employee && u.employee.department) || u.atsDepartment || null,
      seat: seatOf(u),
    })),
    emptySeats: seats
      .filter((p) => p.kind === 'RECRUITER' && !(p.assignments || []).some((a) => a.employee && !LEFT.includes(a.employee.employmentStatus)))
      .map((p) => ({ id: p.id, code: p.code, department: p.department, team: p.team })),
    history,
    note: 'Seats are permanent: moving a person ends their old seat on the day before and starts the new one, so the history of who sat where stays.',
  });
}));

module.exports = router;
