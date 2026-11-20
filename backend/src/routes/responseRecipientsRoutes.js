// ---------------------------------------------------------------------------
// WHO RECEIVES THE RESPONSES OF A JOB (founder 2026-11-20) - registered on the requirements router (routes/requirements.js), so
// router.param's scope check runs first for every /:id here. Rules and routing: utils/responseRecipients.js.
//
//   GET /requirements/:id/response-recipients[?options=1]
//        { set, ids, people, setBy, setAt, reason, assigned, canChange, required, history, options? }
//        options = the recruiters this login may tick, grouped (a TL: their own team; Education Team A / B apart;
//        Admin / Super Admin: everyone, the job's TL's team first), each marked `assigned` when on the job.
//   PUT /requirements/:id/response-recipients { userIds: [...], reason }
//        the job's TL (or STL / Manager on its chain) and Admin / Super Admin. Never a Recruiter or the BDE side (403).
//        At least one recruiter; a change of an existing list needs a reason. Audited, in the requirement history; a recruiter
//        taken off hands their unworked new responses to the others; the people added get a bell.
// The assigned recruiters (POST /:id/assign) are not touched here.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const RR = require('../utils/responseRecipients');
const { atsScopeOf, isBdeTl } = require('../utils/scope');
const { notifyUsers } = require('../utils/notify');

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const LEFT = ['Exited', 'Relieved', 'Terminated'];
const isClient = (u) => [u.role, u.atsRole].includes('CLIENT') || [u.role, u.atsRole].includes('CANDIDATE');
const NOT_YOURS = 'Only the job\'s team lead or an Admin chooses who receives the responses.';

module.exports = function mount(router, { requirementPermissions, recruiterBench }) {
  async function mayChange(user, r) {
    if (isClient(user)) return { ok: false, error: NOT_YOURS };
    const s = atsScopeOf(user);
    if (s.global) return { ok: true, admin: true };
    const role = s.atsRole || user.atsRole;
    if (!['TL', 'STL', 'MANAGER', 'ASSISTANT_MANAGER'].includes(role) || isBdeTl(user)) return { ok: false, error: NOT_YOURS };
    const perms = await requirementPermissions(user, r);
    if (!(perms.post || perms.assign)) return { ok: false, error: 'This requirement is not your team\'s, so you cannot choose who receives its responses.' };
    return { ok: true, admin: false };
  }

  // The recruiters this login may tick, grouped. -> { groups, allowed:Set }
  async function optionsFor(user, r, admin) {
    const assigned = [r.recruiterId, ...csv(r.recruiterIds)].filter(Boolean);
    const bench = await recruiterBench(user, { tlId: r.tlId || null, department: r.department || null }).catch(() => ({ groups: [] }));
    const other = (!admin && user.atsEduTeam && user.atsEduTeam.otherUserIds) || [];
    const groups = (bench.groups || []).map((g) => ({
      key: g.key,
      label: g.label,
      people: g.people.filter((p) => !other.includes(p.id)).map((p) => ({ id: p.id, name: p.name, seat: p.seat ? (p.seat.code || p.seat) : null, assigned: assigned.includes(p.id) })),
    })).filter((g) => g.people.length);
    const seen = new Set(groups.flatMap((g) => g.people.map((p) => p.id)));
    // an assigned recruiter outside the list (e.g. an Admin put them on the job) can still be ticked - unless the other Education team
    const extra = assigned.filter((id) => !seen.has(id) && !other.includes(id));
    if (extra.length) {
      const here = await RR.stillHere(extra);
      const recs = await prisma.user.findMany({ where: { id: { in: here.map((p) => p.id) }, atsRole: 'RECRUITER' }, select: { id: true, name: true } });
      if (recs.length) {
        groups.unshift({ key: 'assigned', label: 'Assigned to this job', people: recs.map((p) => ({ id: p.id, name: p.name, seat: null, assigned: true })) });
        recs.forEach((p) => seen.add(p.id));
      }
    }
    return { groups, allowed: seen };
  }

  async function state(user, r, { options = false } = {}) {
    const row = await RR.get(r.id);
    const ids = row ? row.ids : [];
    const assignedIds = [r.recruiterId, ...csv(r.recruiterIds)].filter(Boolean);
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set([...ids, ...assignedIds])] } },
      select: { id: true, name: true, status: true, employee: { select: { employmentStatus: true } } },
    });
    const by = new Map(users.map((u) => [u.id, u]));
    const person = (id) => {
      const u = by.get(id);
      return { id, name: u ? u.name : 'A recruiter', left: !u || u.status !== 'Active' || !!(u.employee && LEFT.includes(u.employee.employmentStatus)) };
    };
    const may = await mayChange(user, r);
    const since = RR.sinceDate();
    const out = {
      set: ids.length > 0,
      ids,
      people: ids.map(person),
      setBy: row ? row.setByName : null,
      setAt: row ? row.setAt : null,
      reason: row ? row.reason : null,
      assignedIds,
      assigned: assignedIds.map(person),
      canChange: may.ok,
      // a job created after this went live is posted only with recipients ticked; older jobs keep today's behaviour
      required: !(since && new Date(r.createdAt) < since),
      history: await RR.history(r.id, 30),
    };
    if (options && may.ok) out.options = (await optionsFor(user, r, may.admin)).groups;
    return out;
  }

  router.get('/:id/response-recipients', async (req, res, next) => {
    try {
      if (isClient(req.user)) return res.status(403).json({ error: 'This is internal to TeamLink.' });
      await RR.sweepLeft(req.requirement.id, null).catch(() => 0); // a recipient who left: off the list, responses moved
      return res.json(await state(req.user, req.requirement, { options: !!req.query.options }));
    } catch (e) { return next(e); }
  });

  router.put('/:id/response-recipients', async (req, res, next) => {
    try {
      const r = req.requirement;
      const may = await mayChange(req.user, r);
      if (!may.ok) return res.status(403).json({ error: may.error });
      const ids = RR.clean(req.body && req.body.userIds);
      if (!ids.length) return res.status(400).json({ error: 'Tick at least one recruiter who receives the responses.', code: RR.CODE });
      const row = await RR.get(r.id);
      const before = row ? row.ids : [];
      const same = before.length === ids.length && before.every((id) => ids.includes(id));
      if (same) return res.json({ ...(await state(req.user, r)), ok: 'Nothing changed.' });
      const reason = String((req.body && req.body.reason) || '').trim();
      if (before.length && reason.length < 3) return res.status(400).json({ error: 'Say why the responses go to other people (a short reason).', code: 'REASON_NEEDED' });

      // every one must be a recruiter who is still working
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, atsRole: true, status: true, employee: { select: { employmentStatus: true } } } });
      const found = new Map(users.map((u) => [u.id, u]));
      const bad = ids.filter((id) => {
        const u = found.get(id);
        return !u || u.atsRole !== 'RECRUITER' || u.status !== 'Active' || (u.employee && LEFT.includes(u.employee.employmentStatus));
      });
      if (bad.length) {
        const words = bad.map((id) => (found.get(id) ? found.get(id).name : 'an unknown person')).join(', ');
        return res.status(400).json({ error: `Only working recruiters receive responses: ${words} cannot.` });
      }
      // a TL ticks their own team only (Education Team A and Team B apart); an Admin / Super Admin any recruiter
      if (!may.admin) {
        const { allowed } = await optionsFor(req.user, r, false);
        const other = (req.user.atsEduTeam && req.user.atsEduTeam.otherUserIds) || [];
        const outside = ids.filter((id) => !allowed.has(id));
        if (outside.length) {
          const words = outside.map((id) => found.get(id).name).join(', ');
          const edu = outside.some((id) => other.includes(id));
          return res.status(403).json({
            error: edu
              ? `${words} ${outside.length === 1 ? 'is' : 'are'} in the other Education team. You can tick only your own team's recruiters.`
              : `${words} ${outside.length === 1 ? 'is' : 'are'} not in your team. You can tick only your own team's recruiters.`,
            code: 'NOT_YOUR_TEAM',
          });
        }
      }

      const by = { id: req.user.id, name: req.user.name };
      await RR.save(r, ids, { by, reason: reason || null });
      const added = ids.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !ids.includes(id));
      let moved = 0;
      if (removed.length) {
        const here = await RR.stillHere(ids);
        moved = await RR.reassignUnworked(r, removed, here, { by, kind: 'response recipient changed', reason: reason || null });
      }
      const others = ids.length > 1 ? ' They are shared in turn between the recruiters ticked.' : '';
      await notifyUsers(added, {
        title: `You receive the responses — ${r.reqCode || r.title}`,
        message: `${req.user.name} chose you to receive the responses of ${r.title}: the people who apply on the Job Portal, the careers page, the job boards and the apply links.${others}`,
        open: `/requirements/${r.id}?tab=recruiter`,
        exceptUserId: req.user.id,
      }).catch(() => {});
      const out = await state(req.user, r);
      const names = out.people.map((p) => p.name).join(', ');
      return res.json({ ...out, moved, ok: `Saved. Responses go to ${names}.${moved ? ` ${moved} unworked response${moved === 1 ? '' : 's'} moved to them.` : ''}` });
    } catch (e) { return next(e); }
  });
};
