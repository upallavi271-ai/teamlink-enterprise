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
const { atsViewRole, isBdeTl, requirementWhere } = require('../utils/scope');
const JC = require('../utils/jobCreateRule'); // edit / hold / close of a job: the BDE team and above (2026-10-13)
const { requirementIsLive, requirementStatusLabel, requirementStatusUser, requirementStateWords, agreementIsActive } = require('../utils/atsVocab');
const { newWorkRefusal, isSuperAdmin, isBdeTeam } = require('../utils/clientLifecycle');
const posting = require('../utils/jobPosting');
const { can } = require('../middleware/auth');
const CR = require('../utils/clientRequests');
const { scopeOf } = require('../utils/scope');
const { notifyUsers } = require('../utils/notify');

const PAUSED = 'Requirement paused';
const RESUMED = 'Requirement resumed';
const CLOSED = 'Requirement closed';
// Audit rows written before 2026-10-17 carry the old wording; reads accept both.
const LEGACY = { paused: 'Job paused', closed: 'Job closed' };
const REOPENED = 'Requirement reopened';
// A job is only ever Open or Closed (2026-10-13). WHY it closed is a REASON kept with the close, never a status.
const OUTCOMES = { filled: 'Filled', cancelled: 'Client cancelled', paused: 'On hold', hold: 'On hold', other: 'Other' };
const CLOSE_REASONS = [
  { key: 'filled', label: 'Filled', hint: 'We gave the client the people they needed.' },
  { key: 'cancelled', label: 'Client cancelled', hint: 'The client no longer needs it.' },
  { key: 'paused', label: 'On hold (paused)', hint: 'Stopped for now. You can reopen it later.' },
  { key: 'other', label: 'Other', hint: 'Something else. Say what in the note.' },
];
const niceOutcome = (v) => (v === 'Cancelled' ? 'Client cancelled' : v);
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
      prisma.auditLog.findFirst({ where: { entity: 'Requirement', entityId: r.id, action: { in: [PAUSED, LEGACY.paused] } }, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } }),
      prisma.auditLog.findFirst({ where: { entity: 'Requirement', entityId: r.id, action: { in: [CLOSED, LEGACY.closed, 'Job closed'] } }, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } }),
    ]);
    const viewRole = atsViewRole(user);
    const bde = viewRole === 'bde' || isBdeTl(user); // the BDE TL works a job like a BDE: close only
    // A desk BDE (not the BDE team lead) PAUSES / RESUMES their own jobs and ASKS to close one (user spec 2026-10-10).
    const deskBde = viewRole === 'bde' && !isBdeTl(user) && !scopeOf(user).global;
    const [bdePause, bdeResume, bdeClose] = bde ? await Promise.all([
      can(user, 'ats', 'requirements', 'Pause Requirement', 'edit'),
      can(user, 'ats', 'requirements', 'Resume Requirement', 'edit'),
      can(user, 'ats', 'requirements', 'Close Request', 'create'),
    ]) : [false, false, false];
    const closeAsk = !!(r.id && await prisma.auditLog.findFirst({ where: { action: CR.KINDS.closejob.action, entity: 'Requirement', entityId: r.id, approvalStatus: 'Pending' }, select: { id: true } }));
    const holdOnly = holdOnlyRole(user);
    const live = requirementIsLive(r.status);
    const sa = isSuperAdmin(user) || isBdeTeam(user); // 2026-10-16: delete is the Super Admin's and the BDE team's (own area: perms.delete)
    let hold = null;
    if (r.status === 'ON_HOLD') {
      hold = lastHold
        ? { reason: lastHold.reason || null, until: lastHold.toValue || null, by: lastHold.user ? lastHold.user.name : (lastHold.actorName || null), at: lastHold.createdAt }
        : { reason: null, until: null, by: null, at: null };
      hold.late = !!(hold.until && isDay(hold.until) && hold.until < todayStr());
    }
    const closed = r.status === 'CLOSED' && lastClose
      ? { outcome: niceOutcome(lastClose.toValue) || null, note: lastClose.reason || null, by: lastClose.user ? lastClose.user.name : (lastClose.actorName || null), at: lastClose.createdAt }
      : (r.status === 'CLOSED' ? { outcome: null, note: null, by: null, at: null } : null);
    const paused = newWorkRefusal(client, 'new candidates');
    return {
      id: r.id,
      status: r.status,
      statusLabel: requirementStatusUser(r.status),
      note: r.status === 'CLOSED' ? '' : (require('../utils/requirementDisplayStatus').noteOf(r.status)), // eslint-disable-line global-require
      closeReasons: CLOSE_REASONS,
      live,
      hold,
      closed,
      people: apps,
      invoices,
      client: client && !r.internal ? { name: client.name, paused: !!paused, message: paused ? `${client.name} is paused, so this requirement takes no new candidates and nothing new is sent to the client.` : null } : null,
      rights: {
        // 2026-10-13: a job is only Open or Closed. "On hold" is now a REASON in the Close dialog, so nobody pauses a job any more
        // (a job that is already paused can still be resumed).
        pause: false && !!perms.approve && live && (!bde || bdePause),
        resume: !!perms.approve && r.status === 'ON_HOLD' && (!bde || bdeResume),
        // A desk BDE does not close: they ASK (requestClose), a Manager / Admin approves.
        close: !!perms.approve && !holdOnly && r.status !== 'CLOSED',
        // 2026-10-13: the BDE team closes directly (with a reason); nobody asks any more
        requestClose: false,
        closeRequested: closeAsk,
        // The BDE only asks for a recruiter; the TL picks one.
        requestRecruiter: false,
        reopen: !!perms.approve && !holdOnly && r.status === 'CLOSED',
        // Super Admin and the BDE team, and never while people or invoices are attached.
        delete: sa && !!perms.delete && apps === 0 && invoices === 0,
        deleteBlocked: sa && (apps || invoices)
          ? `This requirement has ${apps} ${apps === 1 ? 'person' : 'people'}${invoices ? ` and ${invoices} invoice(s)` : ''} on it, so it cannot be deleted. Close it instead.`
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
    // Job distribution (2026-10-14): a closed job gets its "take it down from these places" checklist. Never fails the close.
    if (to === 'CLOSED') require('../jobDist/tracker').onJobClosed(r.id, req.user).catch(() => {}); // eslint-disable-line global-require
    return res.json({ ok, lifecycle: await lifecycleOf(req.user, updated) });
  }

  // PAUSE = hold, with a reason and a date to look at it again.
  router.post('/:id/pause', JC.requireJobManage(), async (req, res) => {
    const r = req.requirement;
    const lc = await lifecycleOf(req.user, r);
    if (!lc.rights.pause) {
      return res.status(403).json({ error: requirementIsLive(r.status) ? 'You cannot pause this requirement. Ask its TL, a Manager or an Admin.' : `This requirement is ${lc.statusLabel}, so it cannot be paused.` });
    }
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    const until = String((req.body && req.body.until) || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Write why the requirement is paused (at least 3 letters).' });
    if (!isDay(until)) return res.status(400).json({ error: 'Pick the date to look at this requirement again.' });
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
      return res.status(403).json({ error: `You cannot ${verb} this requirement.` });
    }
    const client = r.clientId ? await prisma.client.findUnique({ where: { id: r.clientId } }) : null;
    if (!r.internal && !agreementIsActive(client && client.agreementStatus)) {
      return res.status(400).json({ error: await gateRefusal(req.user, client, `Cannot ${verb} yet`) });
    }
    const to = (r.recruiterId || csv(r.recruiterIds).length) ? 'RECRUITER_ASSIGNED' : 'OPEN';
    return move(req, res, { to, action, ok: `${verb === 'resume' ? 'Resumed' : 'Reopened'} — the requirement is open again.` });
  }
  router.post('/:id/resume', JC.requireJobManage(), (req, res) => backToLive(req, res, { from: 'ON_HOLD', action: RESUMED, verb: 'resume' }));
  router.post('/:id/reopen', JC.requireJobManage(), (req, res) => backToLive(req, res, { from: 'CLOSED', action: REOPENED, verb: 'reopen' }));

  // CLOSE = filled or cancelled.
  router.post('/:id/close', JC.requireJobManage(), async (req, res) => {
    const r = req.requirement;
    const lc = await lifecycleOf(req.user, r);
    if (!lc.rights.close) {
      if (lc.rights.requestClose) return res.status(403).json({ error: 'A BDE asks to close a requirement: press Ask to close. A Manager or an Admin approves it.', code: 'CLOSE_NEEDS_APPROVAL' });
      return res.status(403).json({ error: r.status === 'CLOSED' ? 'This requirement is already closed.' : 'You cannot close this requirement. Ask a Manager or an Admin.' });
    }
    const outcome = OUTCOMES[String((req.body && req.body.outcome) || '').toLowerCase()];
    if (!outcome) return res.status(400).json({ error: 'Choose why the requirement is closing: Filled, Client cancelled, On hold or Other.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300) || null;
    if (['Client cancelled', 'Other'].includes(outcome) && (!note || note.length < 3)) return res.status(400).json({ error: outcome === 'Other' ? 'Write the reason in the note.' : 'Write why the client cancelled.' });
    return move(req, res, { to: 'CLOSED', action: CLOSED, toValue: outcome, reason: note, ok: `Closed — ${outcome.toLowerCase()}.` });
  });

  // ---- ASK TO CLOSE (BDE) - a Manager / Admin approves (utils/clientRequests.js 'closejob') -----------
  router.post('/:id/close-request', JC.requireJobManage(), async (req, res, next) => {
    // RETIRED 2026-10-13: the BDE team closes and assigns jobs directly now (job rule); only the Manager / Admin close path stays.
    if (process.env.BDE_JOB_REQUESTS !== '1') return res.status(410).json({ error: 'A BDE closes a requirement directly now. Use Close requirement.' });
    try {
      const r = req.requirement;
      const lc = await lifecycleOf(req.user, r);
      if (!lc.rights.requestClose) {
        return res.status(lc.rights.closeRequested ? 409 : 403).json({ error: lc.rights.closeRequested ? 'A close request for this requirement is already waiting for approval.' : (r.status === 'CLOSED' ? 'This requirement is already closed.' : 'You cannot ask to close this requirement.') });
      }
      const outcome = OUTCOMES[String((req.body && req.body.outcome) || '').toLowerCase()];
      if (!outcome) return res.status(400).json({ error: 'Choose why the requirement is closed: Filled (hiring complete) or Cancelled (the client cancelled).' });
      const why = CR.reasonOf(req.body && (req.body.note ?? req.body.reason), 'note');
      if (why.error) return res.status(400).json({ error: why.error });
      const client = r.clientId ? await prisma.client.findUnique({ where: { id: r.clientId } }) : null;
      if (!client) return res.status(400).json({ error: 'This requirement has no client.' });
      const out = await CR.createRequest({ user: req.user, kind: 'closejob', client, requirement: r, reason: why.reason, ask: { field: 'status', fromValue: r.status, toValue: 'Closed - ' + outcome } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  // The approver's side: close the job exactly as a direct close does (same audit row, same portal push).
  CR.hooks.closeJob = async ({ user, requirement, outcome, reason }) => {
    const cur = await prisma.requirement.findUnique({ where: { id: requirement.id } });
    if (!cur) return { error: 'The requirement no longer exists.', status: 404 };
    if (cur.status === 'CLOSED') return { error: 'This requirement is already closed.', status: 409 };
    const updated = await prisma.requirement.update({ where: { id: cur.id }, data: { status: 'CLOSED' } });
    await logAudit({ userId: user.id, actorName: user.name, action: CLOSED, entity: 'Requirement', entityId: cur.id, fromValue: cur.status, toValue: outcome, reason: reason || null, approvalStatus: 'Approved', approvedByName: user.name || null, approvedAt: new Date() });
    await pushToPortal(updated, { user, trigger: 'status', prevStatus: cur.status });
    require('../jobDist/tracker').onJobClosed(cur.id, user).catch(() => {}); // eslint-disable-line global-require
    return { ok: true };
  };

  // ---- ASK FOR A RECRUITER (BDE) - the BDE only asks; the TL picks the recruiter (assign stays the TL's) ------
  router.post('/:id/recruiter-request', async (req, res, next) => {
    if (process.env.BDE_JOB_REQUESTS !== '1') return res.status(410).json({ error: 'A BDE picks the recruiter directly now. Use Assign.' }); // RETIRED 2026-10-13
    try {
      const r = req.requirement;
      if (atsViewRole(req.user) !== 'bde' && !isBdeTl(req.user)) return res.status(403).json({ error: 'Asking for a recruiter is for the BDE of this client.' });
      const perms = await requirementPermissions(req.user, r);
      if (!perms.approve && !perms.edit) return res.status(403).json({ error: 'This requirement is not yours.' });
      const note = CR.reasonOf(req.body && req.body.note, 'note');
      if (note.error) return res.status(400).json({ error: note.error });
      let wanted = '';
      if (req.body && req.body.recruiterId) {
        const u = await prisma.user.findUnique({ where: { id: String(req.body.recruiterId) }, select: { id: true, name: true } });
        if (!u) return res.status(400).json({ error: 'Pick a recruiter from the list.' });
        wanted = u.name;
      }
      let tlIds = r.tlId ? [r.tlId] : [];
      if (!tlIds.length && r.department) {
        const tls = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', OR: [{ atsDepartment: r.department }, { atsScopeDepartments: { contains: r.department } }] }, select: { id: true, name: true, email: true } });
        tlIds = tls.filter((u) => process.env.TEST_MODE || !/zztest|example\.test/i.test(u.name + ' ' + u.email)).map((u) => u.id);
      }
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Recruiter requested for requirement', entity: 'Requirement', entityId: r.id, toValue: wanted || 'Any recruiter', reason: note.reason });
      await notifyUsers(tlIds, { title: 'Recruiter wanted - ' + (r.reqCode || r.title), message: (req.user.name || 'The BDE') + ' asks for ' + (wanted || 'a recruiter') + ' on ' + r.title + ': ' + note.reason + '.\nOpen: /requirements/' + r.id, exceptUserId: req.user.id }).catch(() => null);
      return res.status(201).json({ ok: true, notified: tlIds.length, message: tlIds.length ? 'Your team lead is asked to pick a recruiter.' : 'Saved. No team lead is named on this requirement yet.' });
    } catch (e) { return next(e); }
  });

  // ---- posting sites --------------------------------------------------------
  async function sitesPayload(user, r) {
    const perms = await requirementPermissions(user, r);
    const sites = await posting.siteStatuses(r, user);
    return {
      sites,
      // One sentence for the Save & Post panel and the job page ("Posted automatically on 2 of 6 sites. …").
      summary: require('../utils/jobConnectors').summarise(sites), // eslint-disable-line global-require
      live: requirementIsLive(r.status),
      canEdit: !!perms.share,
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
    if (!perms.share) return res.status(403).json(require('../utils/postingGuard').POSTING_BODY);
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

  // ---- THE USUAL SITES + THE HAND-POSTING QUEUE (2026-10-10) -----------------------------
  // GET  /requirements/posting/defaults   the sites a new job starts with ticked (+ may this login change them)
  // PUT  /requirements/posting/defaults   { sites: ['jobportal', …] } — Admin / Super Admin only
  // POST /requirements/posting/hand-queue { ids?: [jobId…] } the (job, board) pairs still waiting for a person
  //      to post them by hand, in this login's scope and only for jobs it may post: the "Post them one by one"
  //      helper walks through them (Copy text / Open board / I posted it).
  router.get('/posting/defaults', async (req, res, next) => {
    try {
      if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
      const d = await posting.defaultSites();
      return res.json({ ids: d.ids, custom: d.custom, by: d.by || null, at: d.at || null, canEdit: await mayChooseUsual(req.user) });
    } catch (e) { return next(e); }
  });
  // Super Admin and Admin (and anyone who may set up Integrations) choose the usual set.
  const mayChooseUsual = async (user) => isSuperAdmin(user) || [user.role, user.atsRole].includes('ADMIN') || require('../utils/jobConnectors').canSetUp(user); // eslint-disable-line global-require
  router.put('/posting/defaults', async (req, res, next) => {
    try {
      if (!(await mayChooseUsual(req.user))) return res.status(403).json({ error: 'Only an Admin can change the usual sites for new requirements.' }); // eslint-disable-line global-require
      const wanted = Array.isArray(req.body && req.body.sites) ? req.body.sites.map(String) : null;
      if (!wanted) return res.status(400).json({ error: 'Send the list of sites.' });
      const ids = await posting.setDefaultSites(wanted, req.user);
      return res.json({ ok: ids.length ? 'Saved. New requirements now start with these sites ticked.' : 'Saved. New requirements now start with no site ticked.', ids, custom: true });
    } catch (e) { return next(e); }
  });
  router.post('/posting/hand-queue', async (req, res, next) => {
    try {
      if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
      const connectors = require('../utils/jobConnectors'); // eslint-disable-line global-require
      const guide = require('../utils/jobBoards/guide'); // eslint-disable-line global-require
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).slice(0, 200) : null;
      const and = [requirementWhere(req.user), connectors.waitingHandWhere()];
      if (ids) and.push({ id: { in: ids.length ? ids : ['__none__'] } });
      const jobs = await prisma.requirement.findMany({ where: { AND: and }, include: { client: { select: { name: true } }, postings: true }, orderBy: { createdAt: 'desc' }, take: 120 });
      const readyBoards = new Set();
      for (const b of Object.keys(guide.GUIDE)) {
        // eslint-disable-next-line no-await-in-loop
        if (await connectors.boardIsReady(b)) readyBoards.add(b);
      }
      const hours = await require('../utils/jobBoards/manual').reminderHours().catch(() => 6); // eslint-disable-line global-require
      const pairs = [];
      let skipped = 0;
      for (const j of jobs) {
        // eslint-disable-next-line no-await-in-loop
        const perms = await requirementPermissions(req.user, j);
        if (!perms.share) { skipped += 1; continue; } // eslint-disable-line no-continue
        const boardOrder = Object.keys(guide.GUIDE); // Naukri, Shine, Indeed, LinkedIn
        j.postings.slice().sort((a, b) => boardOrder.indexOf(a.source) - boardOrder.indexOf(b.source)).filter((p) => guide.GUIDE[p.source] && ['Integration Required', 'Setup Required'].includes(p.status)
          && posting.siteTicked(j, p.source) && !readyBoards.has(p.source)).forEach((p) => {
          const waited = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 3600000);
          pairs.push({
            requirementId: j.id, reqCode: j.reqCode || null, title: j.title, client: j.internal || !j.client ? null : j.client.name,
            board: p.source, boardName: guide.GUIDE[p.source].name, waitedHours: waited, overdue: waited >= hours,
          });
        });
      }
      const perBoard = {};
      pairs.forEach((p) => { perBoard[p.board] = (perBoard[p.board] || 0) + 1; });
      return res.json({ pairs, total: pairs.length, jobs: new Set(pairs.map((p) => p.requirementId)).size, perBoard, skipped });
    } catch (e) { return next(e); }
  });

  // Retry ONE source now (Save & Post, utils/jobConnectors.js) — waits for
  // that source's answer and returns the fresh statuses.
  router.post('/:id/posting-sites/:source/retry', async (req, res) => {
    const r = req.requirement;
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) return res.status(403).json({ error: 'Posting is internal to TeamLink.' });
    const perms = await requirementPermissions(req.user, r);
    if (!perms.share) return res.status(403).json(require('../utils/postingGuard').POSTING_BODY);
    // eslint-disable-next-line global-require
    const connectors = require('../utils/jobConnectors');
    const src = connectors.sourceById(String(req.params.source || ''));
    if (!src) return res.status(404).json({ error: 'Unknown posting site.' });
    if (!requirementIsLive(r.status)) return res.status(400).json({ error: `This requirement is ${requirementStateWords(r.status)}, so it is not posted anywhere. Open it first.` });
    // Our own sites: publish the job again first (a person may have unpublished it).
    if (src.kind !== 'board') await posting.autoPost(r.id, { actorId: req.user.id, actorName: req.user.name, trigger: 'retry', skipSources: true });
    await connectors.retry(r.id, { actorId: req.user.id, actorName: req.user.name }, src.id);
    const fresh = await prisma.requirement.findUnique({ where: { id: r.id } });
    const payload = await sitesPayload(req.user, fresh);
    const site = payload.sites.find((x) => x.id === src.id);
    return res.json({ ...payload, ok: site && site.status === 'Posted' ? `${src.label}: posted.` : `${src.label}: ${site ? site.status : 'tried again'}.` });
  });

  // ---- POST BY HAND (utils/jobBoards/manual.js) ------------------------------
  // For a board with no open posting API (or one not connected yet): the job in
  // that board's order of fields, ready to copy; the board's own "post a job"
  // page; and "I posted it" (with the live link) / "I took it down" / "Undo".
  // Nothing is ever sent to the board and the row is never shown as Posted.
  const handDeps = async (req, res) => {
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) { res.status(403).json({ error: 'Posting is internal to TeamLink.' }); return null; }
    const perms = await requirementPermissions(req.user, req.requirement);
    if (!perms.share) { res.status(403).json(require('../utils/postingGuard').POSTING_BODY); return null; }
    const board = String(req.params.source || '');
    const manual = require('../utils/jobBoards/manual'); // eslint-disable-line global-require
    if (!require('../utils/jobBoards/guide').GUIDE[board]) { res.status(404).json({ error: 'This site cannot be posted by hand.' }); return null; } // eslint-disable-line global-require
    return { board, manual };
  };
  const handBase = (req) => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`.replace(':4010', ':5183');
  router.get('/:id/posting-sites/:source/by-hand', async (req, res, next) => {
    try {
      const d = await handDeps(req, res); if (!d) return undefined;
      const out = await d.manual.helper(req.requirement, d.board, handBase(req));
      return res.json({ ...out, live: requirementIsLive(req.requirement.status), publicLink: !!process.env.APP_BASE_URL });
    } catch (e) { return next(e); }
  });
  async function handAfter(req, res, d, out, okText) {
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    const fresh = await prisma.requirement.findUnique({ where: { id: req.requirement.id } });
    return res.json({ ...(await sitesPayload(req.user, fresh)), ok: okText, helper: await d.manual.helper(fresh, d.board, handBase(req)) });
  }
  router.post('/:id/posting-sites/:source/by-hand/done', async (req, res, next) => {
    try {
      const d = await handDeps(req, res); if (!d) return undefined;
      if (!requirementIsLive(req.requirement.status)) return res.status(400).json({ error: `This requirement is ${requirementStateWords(req.requirement.status)}, so it should not be posted. Open it first.` });
      // Posting by hand also ticks the board for this job, so the page and the audit agree.
      if (!posting.tickedSites(req.requirement).includes(d.board)) {
        const ids = [...posting.tickedSites(req.requirement), d.board];
        await prisma.requirement.update({ where: { id: req.requirement.id }, data: { postingSources: posting.postingSourcesFor(req.requirement, ids) } });
      }
      const out = await d.manual.markDone(req.requirement, d.board, req.user, req.body && req.body.url);
      return handAfter(req, res, d, out, `Saved: posted on ${require('../utils/jobBoards/guide').GUIDE[d.board].name} by hand by ${req.user.name}.`); // eslint-disable-line global-require
    } catch (e) { return next(e); }
  });
  router.post('/:id/posting-sites/:source/by-hand/removed', async (req, res, next) => {
    try {
      const d = await handDeps(req, res); if (!d) return undefined;
      return handAfter(req, res, d, await d.manual.markRemoved(req.requirement, d.board, req.user), 'Saved: taken down.');
    } catch (e) { return next(e); }
  });
  router.post('/:id/posting-sites/:source/by-hand/undo', async (req, res, next) => {
    try {
      const d = await handDeps(req, res); if (!d) return undefined;
      return handAfter(req, res, d, await d.manual.markUndone(req.requirement, d.board, req.user), 'Undone: it is not marked as posted any more.');
    } catch (e) { return next(e); }
  });

  // ---- WRITE THE JOB POSTS (utils/jobText.js writes, utils/jobPostWriter.js keeps) ------
  // A Master JD + one text per site, from the job's real fields. POST body { overrides: { salary: '…', … } }
  // is what the poster typed for the missing items (nothing is saved into the job unless /job-text/save is called).
  //   GET  /:id/job-posts        the generated texts + the poster's saved edits (who / when) + checklist
  //   POST /:id/job-posts        { texts: { master: '…', naukri: null (= reset), … } } save / reset edits
  //   POST /:id/job-posts/check  { texts } the inclusive-wording + client-name check on the texts as they are now
  //   POST /:id/job-text         (same as GET, with { overrides }): the text refreshes as the poster fills the gaps
  //   POST /:id/job-text/ai      the optional AI polish (+ { current } to diff against)
  //   POST /:id/job-text/save    { overrides } saves the typed gaps into the job itself
  // Same right as posting the job: requirementPermissions().share or .edit, and the job is already in scope.
  const textDeps = async (req, res) => {
    if ([req.user.role, req.user.atsRole].includes('CLIENT')) { res.status(403).json({ error: 'Job text is internal to TeamLink.' }); return null; }
    const perms = await requirementPermissions(req.user, req.requirement);
    if (!perms.share) { res.status(403).json(require('../utils/postingGuard').POSTING_BODY); return null; }
    const jt = require('../utils/jobText'); // eslint-disable-line global-require
    const pw = require('../utils/jobPostWriter'); // eslint-disable-line global-require
    const full = await prisma.requirement.findUnique({ where: { id: req.requirement.id }, include: { client: true } });
    const ov = {};
    const given = (req.body && req.body.overrides) || {};
    jt.OVERRIDE_KEYS.forEach((k) => { if (typeof given[k] === 'string') ov[k] = given[k].slice(0, 4000); });
    return { jt, pw, full, ov, perms };
  };
  const clientNamesOf = (full) => (full.internal || !full.client ? [] : [full.client.name, full.client.legalName].map((n) => String(n || '').trim()).filter((n) => n.length >= 3));
  // The saved edits, with "the job has moved on since you saved this" per text.
  const savedView = (saved, generatedTexts, pw) => {
    if (!saved) return null;
    const stale = {};
    Object.keys(saved.texts).forEach((k) => { stale[k] = !!saved.gen[k] && saved.gen[k] !== pw.hashText(generatedTexts[k]); });
    return { texts: saved.texts, stale, keys: saved.keys || {}, savedAt: saved.savedAt, byName: saved.byName };
  };
  const postsPayload = async (req, d) => {
    const out = await d.jt.generate(d.full, d.ov, handBase(req));
    const ai = await d.jt.aiStatus();
    const saved = savedView(await d.pw.loadSaved(d.full.id), out.texts, d.pw);
    return {
      ...out, saved, ai: { available: ai.available, reason: ai.available ? null : ai.reason },
      canSave: !!d.perms.share, canFill: !!d.perms.edit, live: requirementIsLive(req.requirement.status),
    };
  };
  router.get('/:id/job-posts', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      return res.json(await postsPayload(req, d));
    } catch (e) { return next(e); }
  });
  router.post('/:id/job-text', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      return res.json(await postsPayload(req, d));
    } catch (e) { return next(e); }
  });
  router.post('/:id/job-posts', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      const given = req.body && req.body.texts;
      if (!given || typeof given !== 'object' || Array.isArray(given)) return res.status(400).json({ error: 'There was no text to save.' });
      const edits = {};
      d.pw.TEXT_KEYS.forEach((k) => {
        if (!(k in given)) return;
        if (given[k] !== null && typeof given[k] !== 'string') return;
        edits[k] = given[k];
      });
      if (!Object.keys(edits).length) return res.status(400).json({ error: 'There was no text to save.' });
      // "Same as generated" is judged against what the job writes right now (with the typed gaps, if any).
      const gen = await d.jt.generate(d.full, d.ov, handBase(req));
      const out = await d.pw.saveTexts(d.full.id, edits, gen.texts, req.user);
      if (out.changed.length || out.reset.length) {
        await logAudit({
          userId: req.user.id, actorName: req.user.name, action: out.changed.length ? 'Job posts saved' : 'Job posts reset', entity: 'Requirement', entityId: d.full.id,
          toValue: [out.changed.length ? `saved: ${out.changed.join(', ')}` : '', out.reset.length ? `reset: ${out.reset.join(', ')}` : ''].filter(Boolean).join('; '),
        });
      }
      const msg = out.changed.length
        ? 'Saved. These post texts are kept for this requirement and used when you post by hand.'
        : (out.reset.length ? 'Back to the text TeamLink wrote.' : 'Nothing changed.');
      return res.json({ ok: msg, changed: out.changed, reset: out.reset, saved: savedView(await d.pw.loadSaved(d.full.id), gen.texts, d.pw) });
    } catch (e) { return next(e); }
  });
  router.post('/:id/job-posts/check', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      const given = (req.body && req.body.texts) || {};
      const texts = {};
      d.pw.TEXT_KEYS.forEach((k) => { if (typeof given[k] === 'string') texts[k] = given[k].slice(0, d.pw.MAX_TEXT); });
      return res.json({ warnings: d.jt.lintTexts(texts, clientNamesOf(d.full)) });
    } catch (e) { return next(e); }
  });
  router.post('/:id/job-text/ai', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      const current = {};
      const given = (req.body && req.body.current) || {};
      d.pw.TEXT_KEYS.forEach((k) => { if (typeof given[k] === 'string') current[k] = given[k].slice(0, d.pw.MAX_TEXT); });
      const out = await d.jt.aiDraft(d.full, d.ov, handBase(req), current);
      if (out.error) return res.status(out.status || 400).json({ error: out.error });
      await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Job posts polished with AI', entity: 'Requirement', entityId: d.full.id, toValue: `${Object.keys(out.diff || {}).length} text(s) differ` });
      return res.json({ ...out, canSave: true });
    } catch (e) { return next(e); }
  });
  router.post('/:id/job-text/save', async (req, res, next) => {
    try {
      const d = await textDeps(req, res); if (!d) return undefined;
      if (!d.perms.edit) return res.status(403).json({ error: 'You can read this requirement but not change it. Ask its TL or an Admin.' });
      const out = await d.jt.save(d.full, d.ov, req.user);
      if (!out.saved.length) return res.status(400).json({ error: 'There was nothing typed to save.' });
      return res.json({ ok: `Saved into the requirement: ${out.saved.join(', ')}.`, saved: out.saved });
    } catch (e) { return next(e); }
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
      return res.status(410).json({ error: 'Undo is only possible for 24 hours. Assign the requirements again instead.' });
    }
    const results = [];
    for (const u of rec.rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await prisma.requirement.findUnique({ where: { id: u.id } });
      if (!r) { results.push({ id: u.id, ok: false, error: 'Requirement no longer exists' }); continue; }
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
      message: `Undone — ${done} requirement${done === 1 ? '' : 's'} back as before${left ? `; ${left} changed again since, left as they are` : ''}.`,
    });
  });
};

module.exports.recordUndo = recordUndo;
module.exports.UNDO_MS = UNDO_MS;
