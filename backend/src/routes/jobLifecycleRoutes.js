// ---------------------------------------------------------------------------
// JOB PAUSE / CLOSE / DELETE + BULK-ASSIGN UNDO + POSTING SITES
// (ATS change list 2026-10-03 §5 "Pause, close, delete", "Jobs with no
// recruiter", "Posting"; §16; §22 "No owner").
//
// Registered on the requirements router (routes/requirements.js), so
// router.param('id') has already loaded the job and refused one outside the
// caller's area before any handler below runs.
//
//   GET  /:id/lifecycle        what the job is, why it is paused / closed, and
//                              which of Pause / Resume / Close / Reopen /
//                              Delete this login may press
//   POST /:id/pause            { reason, until: 'YYYY-MM-DD' }  -> On Hold
//   POST /:id/resume           On Hold -> Open / Recruiter Assigned
//   POST /:id/close            { outcome: 'filled' | 'cancelled', note }
//   POST /:id/reopen           Closed -> Open / Recruiter Assigned
//   (DELETE /:id stays in requirements.js — Super Admin only, never with people)
//   GET  /:id/posting-sites    the six sites, ticked or not, with their status
//   PUT  /:id/posting-sites    { sites: ['jobportal','website',…] }
//   POST /bulk/undo            { undoId } — undo a bulk assign within 24 h
//
// The reason and date of a pause, and the outcome of a close, are kept in the
// audit trail (AuditLog) — no new columns. The undo record of a bulk assign is
// one AppSetting row (key jobs.bulkUndo.<id>), removed when it is used or
// when it is more than 24 hours old.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { atsViewRole } = require('../utils/scope');
const { requirementIsLive, requirementStatusLabel, agreementIsActive } = require('../utils/atsVocab');
const { newWorkRefusal, isSuperAdmin } = require('../utils/clientLifecycle');
const posting = require('../utils/jobPosting');

const PAUSED = 'Job paused';
const RESUMED = 'Job resumed';
const CLOSED = 'Job closed';
const REOPENED = 'Job reopened';
const OUTCOMES = { filled: 'Filled', cancelled: 'Cancelled' };
const UNDO_PREFIX = 'jobs.bulkUndo.';
const UNDO_MS = 24 * 3600 * 1000;

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(v).getTime());
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const niceDay = (s) => (isDay(s) ? new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : s);

// ---- bulk-assign undo -------------------------------------------------------
// rows: [{ id, field, prev: {…}, next: {…} }] — exactly the columns written.
async function recordUndo({ undoId, user, action, targetName, rows }) {
  if (!rows.length) return undoId || null;
  const id = undoId && /^[a-f0-9]{16}$/.test(undoId) ? undoId : crypto.randomBytes(8).toString('hex');
  const key = `${UNDO_PREFIX}${id}`;
  const existing = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  let rec = null;
  if (existing) {
    try { rec = JSON.parse(existing.value); } catch { rec = null; }
    // Somebody else's undo id is never extended.
    if (rec && rec.byId !== user.id) rec = null;
  }
  if (!rec) rec = { byId: user.id, byName: user.name, action, targetName, at: new Date().toISOString(), rows: [] };
  rec.rows.push(...rows);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(rec), updatedById: user.id, updatedByName: user.name },
    update: { value: JSON.stringify(rec), updatedById: user.id, updatedByName: user.name },
  });
  // Lazy clean-up of old undo records (nothing else reads them).
  prisma.appSetting.deleteMany({ where: { key: { startsWith: UNDO_PREFIX }, updatedAt: { lt: new Date(Date.now() - UNDO_MS) } } }).catch(() => {});
  return id;
}

module.exports = function registerJobLifecycle(router, deps) {
  const { requirementPermissions, holdOnlyRole, pushToPortal, gateRefusal } = deps;

  async function lifecycleOf(user, r) {
    const [perms, client, apps, invoices, lastHold, lastClose] = await Promise.all([
      requirementPermissions(user, r),
      r.clientId ? prisma.client.findUnique({ where: { id: r.clientId }, select: { id: true, name: true, status: true, clientType: true, agreementStatus: true } }) : null,
      prisma.application.count({ where: { requirementId: r.id } }),
      prisma.invoice.count({ where: { requirementId: r.id } }),
      prisma.auditLog.findFirst({ where: { entity: 'Requirement', entityId: r.id, action: PAUSED }, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } }),
      prisma.auditLog.findFirst({ where: { entity: 'Requirement', entityId: r.id, action: CLOSED }, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } }),
    ]);
    const viewRole = atsViewRole(user);
    const bde = viewRole === 'bde';
    const holdOnly = holdOnlyRole(user);
    const live = requirementIsLive(r.status);
    const sa = isSuperAdmin(user);
    let hold = null;
    if (r.status === 'ON_HOLD') {
      hold = lastHold
        ? { reason: lastHold.reason || null, until: lastHold.toValue || null, by: lastHold.user ? lastHold.user.name : (lastHold.actorName || null), at: lastHold.createdAt }
        : { reason: null, until: null, by: null, at: null };
      hold.late = !!(hold.until && isDay(hold.until) && hold.until < todayStr());
    }
    const closed = r.status === 'CLOSED' && lastClose
      ? { outcome: lastClose.toValue || null, note: lastClose.reason || null, by: lastClose.user ? lastClose.user.name : (lastClose.actorName || null), at: lastClose.createdAt }
      : (r.status === 'CLOSED' ? { outcome: null, note: null, by: null, at: null } : null);
    const paused = newWorkRefusal(client, 'new candidates');
    return {
      id: r.id,
      status: r.status,
      statusLabel: requirementStatusLabel(r.status),
      live,
      hold,
      closed,
      people: apps,
      invoices,
      client: client && !r.internal ? { name: client.name, paused: !!paused, message: paused ? `${client.name} is paused, so this job takes no new candidates and nothing new is sent to the client.` : null } : null,
      rights: {
        pause: !!perms.approve && !bde && live,
        resume: !!perms.approve && !bde && r.status === 'ON_HOLD',
        close: !!perms.approve && !holdOnly && r.status !== 'CLOSED',
        reopen: !!perms.approve && !holdOnly && !bde && r.status === 'CLOSED',
        // Super Admin only, and never while people or invoices are attached.
        delete: sa && !!perms.delete && apps === 0 && invoices === 0,
        deleteBlocked: sa && (apps || invoices)
          ? `This job has ${apps} ${apps === 1 ? 'person' : 'people'}${invoices ? ` and ${invoices} invoice(s)` : ''} on it, so it cannot be deleted. Close it instead.`
          : null,
      },
    };
  }

  router.get('/:id/lifecycle', async (req, res) => {
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'This is internal to TeamLink.' });
    return res.json(await lifecycleOf(req.user, req.requirement));
  });

  async function move(req, res, { to, action, fromValue, toValue, reason, ok }) {
    const r = req.requirement;
    const updated = await prisma.requirement.update({ where: { id: r.id }, data: { status: to } });
    await logAudit({
      userId: req.user.id, actorName: req.user.name, action, entity: 'Requirement', entityId: r.id,
      fromValue: fromValue || r.status, toValue: toValue || to, reason: reason || null,
    });
    await pushToPortal(updated, { user: req.user, trigger: 'status', prevStatus: r.status });
    return res.json({ ok, lifecycle: await lifecycleOf(req.user, updated) });
  }

  // PAUSE = hold, with a reason and a date to look at it again.
  router.post('/:id/pause', async (req, res) => {
    const r = req.requirement;
    const lc = await lifecycleOf(req.user, r);
    if (!lc.rights.pause) {
      return res.status(403).json({ error: requirementIsLive(r.status) ? 'You cannot pause this job. Ask its TL, a Manager or an Admin.' : `This job is ${lc.statusLabel}, so it cannot be paused.` });
    }
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    const until = String((req.body && req.body.until) || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Write why the job is paused (at least 3 letters).' });
    if (!isDay(until)) return res.status(400).json({ error: 'Pick the date to look at this job again.' });
    if (until < todayStr()) return res.status(400).json({ error: 'The date must be today or later.' });
    return move(req, res, {
      to: 'ON_HOLD', action: PAUSED, toValue: until, reason,
      ok: `Paused until ${niceDay(until)}. It is off the job sites until you resume it.`,
    });
  });

  async function backToLive(req, res, { from, action, verb }) {
    const r = req.requirement;
    const lc = await lifecycleOf(req.user, r);
    if (!lc.rights[from === 'ON_HOLD' ? 'resume' : 'reopen'] || r.status !== from) {
      return res.status(403).json({ error: `You cannot ${verb} this job.` });
    }
    const client = r.clientId ? await prisma.client.findUnique({ where: { id: r.clientId } }) : null;
    if (!r.internal && !agreementIsActive(client && client.agreementStatus)) {
      return res.status(400).json({ error: await gateRefusal(req.user, client, `Cannot ${verb} yet`) });
    }
    const to = (r.recruiterId || csv(r.recruiterIds).length) ? 'RECRUITER_ASSIGNED' : 'OPEN';
    return move(req, res, { to, action, ok: `${verb === 'resume' ? 'Resumed' : 'Reopened'} — the job is open again.` });
  }
  router.post('/:id/resume', (req, res) => backToLive(req, res, { from: 'ON_HOLD', action: RESUMED, verb: 'resume' }));
  router.post('/:id/reopen', (req, res) => backToLive(req, res, { from: 'CLOSED', action: REOPENED, verb: 'reopen' }));

  // CLOSE = filled or cancelled.
  router.post('/:id/close', async (req, res) => {
    const r = req.requirement;
    const lc = await lifecycleOf(req.user, r);
    if (!lc.rights.close) return res.status(403).json({ error: r.status === 'CLOSED' ? 'This job is already closed.' : 'You cannot close this job. Ask a Manager or an Admin.' });
    const outcome = OUTCOMES[String((req.body && req.body.outcome) || '').toLowerCase()];
    if (!outcome) return res.status(400).json({ error: 'Choose why the job is closed: Filled or Cancelled.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300) || null;
    if (outcome === 'Cancelled' && (!note || note.length < 3)) return res.status(400).json({ error: 'Write why the job was cancelled.' });
    return move(req, res, { to: 'CLOSED', action: CLOSED, toValue: outcome, reason: note, ok: `Closed — ${outcome.toLowerCase()}.` });
  });

  // ---- posting sites --------------------------------------------------------
  async function sitesPayload(user, r) {
    const perms = await requirementPermissions(user, r);
    return {
      sites: await posting.siteStatuses(r, user),
      live: requirementIsLive(r.status),
      canEdit: !!(perms.share || perms.edit),
      feeds: posting.FEED_PATHS,
    };
  }
  router.get('/:id/posting-sites', async (req, res) => {
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
    return res.json(await sitesPayload(req.user, req.requirement));
  });
  router.put('/:id/posting-sites', async (req, res) => {
    const r = req.requirement;
    const perms = await requirementPermissions(req.user, r);
    if (!perms.share && !perms.edit) return res.status(403).json({ error: 'You cannot change where this job is posted. Ask its TL or an Admin.' });
    const wanted = Array.isArray(req.body && req.body.sites) ? req.body.sites.map(String) : null;
    if (!wanted) return res.status(400).json({ error: 'Send the list of ticked sites.' });
    const ids = posting.SITES.map((s) => s.id).filter((id) => wanted.includes(id));
    const before = posting.tickedSites(r);
    const value = posting.postingSourcesFor(r, ids);
    const updated = await prisma.requirement.update({ where: { id: r.id }, data: { postingSources: value } });
    const added = ids.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !ids.includes(id));
    const name = (id) => posting.SITES.find((s) => s.id === id).name;
    if (added.length || removed.length) {
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: 'Job posting sites changed', entity: 'Requirement', entityId: r.id,
        fromValue: before.map(name).join(', ') || 'None', toValue: ids.map(name).join(', ') || 'None',
      });
    }
    // Put it up / take it down on the public sites now (background push).
    await posting.autoPost(r.id, { actorId: req.user.id, actorName: req.user.name, trigger: added.length ? 'retry' : 'edit', sourceTrigger: 'post', background: true });
    const fresh = await prisma.requirement.findUnique({ where: { id: r.id } });
    const msg = !added.length && !removed.length ? 'Nothing changed.'
      : [added.length ? `Added ${added.map(name).join(', ')}` : '', removed.length ? `removed ${removed.map(name).join(', ')}` : ''].filter(Boolean).join('; ');
    return res.json({ ...(await sitesPayload(req.user, fresh)), ok: `Saved. ${msg.charAt(0).toUpperCase()}${msg.slice(1)}.`.replace('..', '.') });
  });

  // Retry ONE source now (Save & Post, utils/jobConnectors.js) — waits for
  // that source's answer and returns the fresh statuses.
  router.post('/:id/posting-sites/:source/retry', async (req, res) => {
    const r = req.requirement;
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
    const perms = await requirementPermissions(req.user, r);
    if (!perms.share && !perms.edit) return res.status(403).json({ error: 'You cannot post this job. Ask its TL or an Admin.' });
    // eslint-disable-next-line global-require
    const connectors = require('../utils/jobConnectors');
    const src = connectors.sourceById(String(req.params.source || ''));
    if (!src) return res.status(404).json({ error: 'Unknown posting site.' });
    if (!requirementIsLive(r.status)) return res.status(400).json({ error: `This job is ${requirementStatusLabel(r.status)}, so it is not posted anywhere. Open it first.` });
    // Our own sites: publish the job again first (a person may have unpublished it).
    if (src.kind !== 'board') await posting.autoPost(r.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'retry', skipSources: true });
    await connectors.retry(r.id, { actorId: req.user.id, actorName: req.user.name }, src.id);
    const fresh = await prisma.requirement.findUnique({ where: { id: r.id } });
    const payload = await sitesPayload(req.user, fresh);
    const site = payload.sites.find((x) => x.id === src.id);
    return res.json({ ...payload, ok: site && site.status === 'Posted' ? `${src.label}: posted.` : `${src.label}: ${site ? site.status : 'tried again'}.` });
  });

  // ---- undo a bulk assign (24 h) -------------------------------------------
  router.post('/bulk/undo', async (req, res) => {
    const id = String((req.body && req.body.undoId) || '');
    if (!/^[a-f0-9]{16}$/.test(id)) return res.status(400).json({ error: 'Nothing to undo.' });
    const key = `${UNDO_PREFIX}${id}`;
    const row = await prisma.appSetting.findUnique({ where: { key } });
    if (!row) return res.status(404).json({ error: 'This change was already undone, or it is older than 24 hours.' });
    let rec;
    try { rec = JSON.parse(row.value); } catch { rec = null; }
    if (!rec || !Array.isArray(rec.rows)) return res.status(404).json({ error: 'Nothing to undo.' });
    if (rec.byId !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: 'Only the person who made this change can undo it.' });
    if (Date.now() - new Date(rec.at).getTime() > UNDO_MS) {
      await prisma.appSetting.delete({ where: { key } }).catch(() => {});
      return res.status(410).json({ error: 'Undo is only possible for 24 hours. Assign the jobs again instead.' });
    }
    const results = [];
    for (const u of rec.rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await prisma.requirement.findUnique({ where: { id: u.id } });
      if (!r) { results.push({ id: u.id, ok: false, error: 'Job no longer exists' }); continue; }
      // Only put back what is still exactly as the bulk assign left it.
      const changedSince = Object.keys(u.next).some((k) => (r[k] ?? null) !== (u.next[k] ?? null));
      if (changedSince) { results.push({ id: u.id, reqCode: r.reqCode, ok: false, error: 'Changed again since — left as it is' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      await prisma.requirement.update({ where: { id: r.id }, data: u.prev });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({
        userId: req.user.id, actorName: req.user.name, action: 'Requirement assignment changed', entity: 'Requirement', entityId: r.id,
        fromValue: [r.tlId, r.recruiterId].filter(Boolean).join(' / ') || 'unassigned',
        toValue: [u.prev.tlId !== undefined ? u.prev.tlId : r.tlId, u.prev.recruiterId !== undefined ? u.prev.recruiterId : r.recruiterId].filter(Boolean).join(' / ') || 'unassigned',
        reason: `Undo of bulk ${rec.action === 'assign-tl' ? 'Assign TL' : 'Assign recruiter'}: ${rec.targetName}`,
      });
      results.push({ id: r.id, reqCode: r.reqCode, ok: true });
    }
    await prisma.appSetting.delete({ where: { key } }).catch(() => {});
    const done = results.filter((x) => x.ok).length;
    const left = results.length - done;
    return res.json({
      ok: true,
      done,
      left,
      results,
      message: `Undone — ${done} job${done === 1 ? '' : 's'} back as before${left ? `; ${left} changed again since, left as they are` : ''}.`,
    });
  });
};

module.exports.recordUndo = recordUndo;
module.exports.UNDO_MS = UNDO_MS;
