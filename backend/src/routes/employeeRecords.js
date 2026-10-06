const express = require('express');
const prisma = require('../db');
const { requireAuth, requirePerm, can } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { employeeRecordWhere, employeeInScope, OUT_OF_SCOPE } = require('../utils/scope');
const attachments = require('../utils/attachments');
const {
  list, parseAudience, parseChannels, resolveAudience, deliver, describeDelivery,
} = require('../utils/audience');

// DISCIPLINARY FOR MANY PEOPLE AT ONCE (2026-10-03). The Log Case form lets
// HR tick one or MORE departments AND/OR pick one or MORE people; the case is
// recorded once per person in the union of the two — de-duplicated, held to
// the caller's scope by the same resolveAudience() every Send-to form uses
// (an out-of-scope department or person is a 403, never silently dropped).
// Exited / relieved people never get a case; test fixtures (ZZTEST /
// example.test, rule 35 of the shared agent rules) are never picked up by a
// real fan-out. The person logging it is left out of a DEPARTMENT expansion
// (HR warning their own department does not warn HR), but can still be named.
const TEST_PERSON = /zztest|example\.test/i;
const isTestPerson = (e) => TEST_PERSON.test(`${e.name || ''} ${e.email || ''}`);

async function resolveCasePick(user, body) {
  const departments = list(body.departments);
  const employeeIds = list(body.employeeIds);
  if (!departments.length && !employeeIds.length) {
    return { ok: false, status: 400, error: 'Pick at least one department or one person.' };
  }
  const picked = new Map();
  let left = 0;
  if (departments.length) {
    const out = await resolveAudience(user, { mode: 'departments', departments, employeeIds: [] });
    if (!out.ok) return out;
    out.employees.forEach((e) => { if (e.id !== user.employeeId) picked.set(e.id, e); });
  }
  if (employeeIds.length) {
    const out = await resolveAudience(user, { mode: 'individuals', departments: [], employeeIds });
    // 400 here only means "every person you named has left" — with
    // departments also ticked that is a skip, not a failure.
    if (!out.ok && out.status !== 400) return out;
    const got = out.ok ? out.employees : [];
    left = employeeIds.length - got.length;
    got.forEach((e) => picked.set(e.id, e));
  }
  const people = [...picked.values()].filter((e) => !isTestPerson(e))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { ok: true, people, departments, left };
}

// The record types that go TO people and so take the shared Send-to picker
// (one or many departments / one or many employees). Everything else here is
// about one person — my ticket, my claim, one asset, one case — and keeps its
// single-target create.
const AUDIENCE_TYPES = ['TARGET', 'RECOGNITION', 'KT', 'SHIFT', 'TIMESHEET'];
const TYPE_LABEL = {
  TARGET: 'New target', RECOGNITION: 'Recognition', KT: 'KT session', SHIFT: 'Shift rostered', TIMESHEET: 'Timesheet entry',
};

// May this login file records FOR OTHER PEOPLE? Any Employee Services write
// (create, or a lead's approve) — never the view-only Manager / Assistant
// Manager, whose can() answers only view/export. `strict` asks create alone,
// for the types whose single-target create already asked it (createRoles).
async function mayWriteForOthers(user, strict) {
  if (await can(user, 'hrms', 'hrms', 'Employee Services', 'create')) return true;
  return !strict && can(user, 'hrms', 'hrms', 'Employee Services', 'approve');
}


// Backs the ~11 similarly-shaped HRMS self-service areas (KT, Targets,
// Resignation, Recognition, Disciplinary, Shift Roster, Timesheet, Assets,
// Expense Claims, Helpdesk, Access Requests, Weekly Ideas) off one EmployeeRecord
// model, discriminated by `type`. Each router mounted from index.js is scoped
// to its own type so the frontend just sees a normal-looking REST resource.
// `createRoles: true` means only someone with HRMS Employee Management reach
// may raise this record type for another employee; the decision (approve/
// reject) always needs hrms/Employee Services/approve from the engine.
// `attachments: true` adds the bill/receipt upload + download pair, today only
// for EXPENSE claims (see utils/attachments.js).
function employeeRecordRouter(type, { createRoles = null, attachments: withFiles = false, denyHrmsRoles = null } = {}) {
  const router = express.Router();
  router.use(requireAuth);
  // Whole record types a given HRMS role must not reach at all — the Shift
  // Roster is not a TL's (access matrix 2026-09-25 §7). The frontend already
  // hides the tab; this is the API half, so a direct URL is refused too.
  if (denyHrmsRoles) {
    router.use((req, res, next) => (denyHrmsRoles.includes(req.user && req.user.hrmsRole)
      ? res.status(403).json({ error: "This isn't included in your role's permissions" })
      : next()));
  }

  // The record, if this user may reach it at all — exactly the rule the list
  // and the free-form patch below already apply, in one place so the upload
  // and the download cannot drift from it.
  // DEPARTMENT-SCOPED, via the one rule in utils/scope.js: an HRMS lead reaches
  // their departments' records and nobody else's; everyone else reaches their
  // own. This covers KT, Targets, Recognition, Disciplinary, Shift Roster,
  // Timesheet, Assets, Expense Claims, Access Requests and Weekly Ideas at once.
  async function reachable(req, id) {
    const record = await prisma.employeeRecord.findUnique({ where: { id }, include: { employee: true } });
    if (!record || record.type !== type) return { error: 404 };
    if (!employeeInScope(req.user, record.employee)) return { error: 403 };
    return { record };
  }

  // The columns a create writes, from the request body — shared by the
  // single-target create and the audience fan-out so the two rows are
  // identical apart from whose they are.
  function recordData(body, user) {
    const {
      title, detail, date, amount, hours, category, priority, progressPct, location,
      achieved, unit, fromName, toName, points,
    } = body;
    return {
      type, title, detail, date, category, priority, location,
      amount: amount != null && amount !== '' ? Number(amount) : null,
      hours: hours != null && hours !== '' ? Number(hours) : null,
      progressPct: progressPct != null && progressPct !== '' ? Number(progressPct) : null,
      // Performance & Development extras (Targets, Recognition, KT,
      // Disciplinary). Ignored by the record types that do not use them.
      achieved: achieved != null && achieved !== '' ? Number(achieved) : null,
      unit: unit || null,
      // Recognition is peer-to-peer, so the giver is whoever is signed in.
      fromName: fromName || (type === 'RECOGNITION' ? (user.name || user.email) : null),
      toName: toName || null,
      points: points != null && points !== '' ? Number(points) : null,
      // Who logged the case — the prototype's Disciplinary "Raised By" column.
      raisedBy: type === 'DISCIPLINARY' ? (user.name || user.email) : null,
    };
  }

  router.get('/', async (req, res) => {
    const where = { type, ...employeeRecordWhere(req.user) };
    if (req.query.employeeId) where.employeeId = req.query.employeeId;
    if (req.query.status) where.status = req.query.status;
    const records = await prisma.employeeRecord.findMany({ where, include: { employee: true }, orderBy: { createdAt: 'desc' } });
    res.json(records);
  });

  router.post('/', async (req, res) => {
    // RAISING A RECORD FOR SOMEONE ELSE IS A WRITE, so it asks a write
    // permission. It used to ask caps.hrmsManage, which is Employee
    // Management/VIEW — so a view-only Manager (§3) could still set another
    // person's target, log a disciplinary case or hand out an asset. It asks
    // hrms/Employee Services/create now, which is the same action the
    // announcements, surveys and asset-inventory routes require.
    if (createRoles && !await can(req.user, 'hrms', 'hrms', 'Employee Services', 'create')) {
      return res.status(403).json({ error: "This isn't included in your role's permissions" });
    }
    const { title } = req.body;

    // DISCIPLINARY, MANY PEOPLE (see resolveCasePick above). A body carrying
    // `departments` and/or `employeeIds` arrays takes this path; a plain
    // `employeeId` is the old one-person create below, untouched.
    // `preview: true` answers "who would this be recorded for" and writes
    // nothing — the form shows that list before the Save button.
    if (type === 'DISCIPLINARY' && (Array.isArray(req.body.departments) || Array.isArray(req.body.employeeIds))) {
      if (req.user.caps.hrmsSelfOnly || !await mayWriteForOthers(req.user, true)) {
        return res.status(403).json({ error: "This isn't included in your role's permissions" });
      }
      const pick = await resolveCasePick(req.user, req.body);
      if (!pick.ok) return res.status(pick.status).json({ error: pick.error });
      const people = pick.people.map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode, department: e.department }));
      if (req.body.preview) return res.json({ count: people.length, people, left: pick.left });
      if (!title) return res.status(400).json({ error: 'Pick what kind of action this is.' });
      if (!people.length) return res.status(400).json({ error: 'Nobody in that choice can get this — they may have left the company.' });
      // One shared reference so the group can be found again later.
      const batch = `DISC-${Date.now().toString(36).toUpperCase()}`;
      const where = [pick.departments.length ? pick.departments.join(', ') : null, `${people.length} people`].filter(Boolean).join(' · ');
      const base = recordData(req.body, req.user);
      const notes = JSON.stringify([{
        author: req.user.name || req.user.email, internal: true, batch,
        text: `Group case ${batch}: recorded for ${where}`,
      }]);
      const created = await prisma.$transaction(pick.people.map((e) => prisma.employeeRecord.create({
        data: { ...base, notes, employeeId: e.id },
      })));
      for (const r of created) {
        // eslint-disable-next-line no-await-in-loop
        await logAudit({ userId: req.user.id, action: `${type} created`, entity: 'EmployeeRecord', entityId: r.id, toValue: batch });
      }
      return res.status(201).json({
        created: created.length, batch, ids: created.map((r) => r.id), left: pick.left,
        message: `Saved for ${created.length} ${created.length === 1 ? 'person' : 'people'}`,
      });
    }

    // AUDIENCE FAN-OUT (utils/audience.js). The record types that are sent to
    // or assigned to people — targets, recognition, KT sessions, shift roster,
    // timesheet entries — accept the shared Send-to picker: everyone in scope,
    // one or MANY departments, or one or MANY employees. One row is written
    // per person it resolves to, exactly the row a single-target create
    // writes, so every list, filter and report reads them unchanged. A body
    // with a plain `employeeId` and no audience is the old single-target call
    // and takes the path below untouched.
    const aud = AUDIENCE_TYPES.includes(type) && !req.user.caps.hrmsSelfOnly ? parseAudience(req.body) : null;
    if (aud) {
      // Writing a record for other people is a write on them: the type's own
      // create gate (targets, recognition) or, for the types any lead could
      // already file for a team member (KT, roster, timesheet), a lead's
      // Employee Services write — create or approve.
      if (!await mayWriteForOthers(req.user, !!createRoles)) {
        return res.status(403).json({ error: "This isn't included in your role's permissions" });
      }
      if (!title) return res.status(400).json({ error: 'title is required' });
      const out = await resolveAudience(req.user, aud);
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      if (!out.employees.length) return res.status(400).json({ error: 'Nobody in that selection is active in your scope.' });
      const base = recordData(req.body, req.user);
      const created = await prisma.$transaction(out.employees.map((e) => prisma.employeeRecord.create({
        data: { ...base, employeeId: e.id, toName: type === 'KT' ? (base.toName || e.name) : base.toName },
      })));
      const delivery = await deliver({
        employees: out.employees,
        channels: parseChannels(req.body.channels),
        title: `${TYPE_LABEL[type] || type}: ${title}`,
        message: req.body.detail || null,
        by: req.user,
        exceptUserId: req.user.id,
      });
      await logAudit({
        userId: req.user.id, action: `${type} created`, entity: 'EmployeeRecord',
        entityId: created[0].id, toValue: `${out.label} (${created.length})`,
      });
      return res.status(201).json({
        created: created.length, label: out.label, ids: created.map((r) => r.id),
        delivery, deliveryText: describeDelivery(delivery),
      });
    }

    let employeeId = req.body.employeeId;
    if (req.user.caps.hrmsSelfOnly) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own) return res.status(404).json({ error: 'No employee record linked to this account' });
      employeeId = own.id;
    }
    if (!employeeId || !title) return res.status(400).json({ error: 'employeeId and title are required' });
    if (!req.user.caps.hrmsSelfOnly) {
      const target = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!target) return res.status(404).json({ error: 'Employee not found' });
      if (!employeeInScope(req.user, target)) return res.status(403).json(OUT_OF_SCOPE);
      // Filing a record FOR SOMEONE ELSE is a write on them, for every type —
      // so a view-only Manager / Assistant Manager (§3, §4) can still file
      // their own claim or timesheet, but not log a KT session or roster a
      // shift against another person.
      if (target.id !== req.user.employeeId && !await mayWriteForOthers(req.user, false)) {
        return res.status(403).json({ error: "This isn't included in your role's permissions" });
      }
    }

    const record = await prisma.employeeRecord.create({
      data: { ...recordData(req.body, req.user), employeeId },
    });
    await logAudit({ userId: req.user.id, action: `${type} created`, entity: 'EmployeeRecord', entityId: record.id });
    res.status(201).json(record);
  });

  router.patch('/:id/status', requirePerm(null, 'hrms', 'Employee Services', 'approve'), async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const reach = await reachable(req, req.params.id);
    if (reach.error === 404) return res.status(404).json({ error: 'Record not found' });
    if (reach.error) return res.status(403).json(OUT_OF_SCOPE);
    const record = await prisma.employeeRecord.update({ where: { id: req.params.id }, data: { status } });
    await logAudit({ userId: req.user.id, action: `${type} status changed`, entity: 'EmployeeRecord', entityId: record.id, toValue: status });
    res.json(record);
  });

  // Free-form field patch (e.g. progress %) — for the record's own employee or HR.
  router.patch('/:id', async (req, res) => {
    const existing = await prisma.employeeRecord.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Record not found' });
    if (req.user.caps.hrmsSelfOnly) {
      const own = await prisma.employee.findUnique({ where: { userId: req.user.id } });
      if (!own || existing.employeeId !== own.id) return res.status(403).json({ error: "This isn't included in your role's permissions" });
    }
    const { progressPct, detail, achieved, amount, unit } = req.body;
    const data = {};
    if (progressPct != null) data.progressPct = Number(progressPct);
    if (detail !== undefined) data.detail = detail;
    if (achieved != null) data.achieved = Number(achieved);
    if (amount != null) data.amount = Number(amount);
    if (unit !== undefined) data.unit = unit;
    const record = await prisma.employeeRecord.update({ where: { id: req.params.id }, data });
    res.json(record);
  });

  if (withFiles) {
    // --- Bill / receipt upload -------------------------------------------
    // No express.json() here: the body is multipart and is read straight off
    // the socket by utils/attachments.js, which aborts past the size cap.
    router.post('/:id/bill', async (req, res, next) => {
      try {
        const { record, error } = await reachable(req, req.params.id);
        if (error === 404) return res.status(404).json({ error: 'Record not found' });
        if (error === 403) return res.status(403).json({ error: "This isn't included in your role's permissions" });

        let parsed;
        try {
          parsed = await attachments.parseMultipart(req);
        } catch (err) {
          return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not read the upload.' });
        }
        let stored;
        try {
          stored = attachments.store(parsed.file);
        } catch (err) {
          return res.status(400).json({ error: attachments.MESSAGE[err.code] || 'Could not store the upload.' });
        }
        // Replacing a bill removes the old bytes rather than orphaning them.
        if (record.billFile) attachments.remove(record.billFile);
        const updated = await prisma.employeeRecord.update({ where: { id: record.id }, data: stored });
        await logAudit({
          userId: req.user.id, action: `${type} bill uploaded`,
          entity: 'EmployeeRecord', entityId: record.id, toValue: stored.billName,
        });
        return res.json(updated);
      } catch (err) { return next(err); }
    });

    // --- Bill / receipt download ------------------------------------------
    // Same scope check as the claim itself. The path is rebuilt from the
    // stored name only after utils/attachments.js has re-validated it, so the
    // id in the URL can never reach a file outside the upload directory.
    router.get('/:id/bill', async (req, res, next) => {
      try {
        const { record, error } = await reachable(req, req.params.id);
        if (error === 404) return res.status(404).json({ error: 'Record not found' });
        if (error === 403) return res.status(403).json({ error: "This isn't included in your role's permissions" });
        if (!record.billFile) return res.status(404).json({ error: 'No bill attached to this claim' });
        const full = attachments.resolveStored(record.billFile);
        if (!full) return res.status(404).json({ error: 'The attached file is no longer on the server' });
        res.setHeader('Content-Type', record.billMime || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // `attachment` — a stored PDF or image is never rendered in-page.
        res.setHeader('Content-Disposition', `attachment; filename="${attachments.safeDisplayName(record.billName)}"`);
        return res.sendFile(full);
      } catch (err) { return next(err); }
    });
  }

  return router;
}

module.exports = employeeRecordRouter;
