// ---------------------------------------------------------------------------
// PENDING APPROVALS AND OVERDUE FOLLOW-UPS -> EVERYONE ABOVE (user, 2026-10-10: "whoever has a
// pending approval or a pending follow-up, an alert must go at once to everyone higher in the chain").
//
// THE LADDER, per item:
//   level 0   the owner: the person the item waits on now (the approver whose turn it is; the
//             follow-up's owner)
//   level 1+  everyone above, in the order of the chain
//
// WHAT COUNTS (live data only, nothing is stored about it):
//   Approvals    every approval step that is Pending (leave, attendance correction, late
//                permission, resignation, rewards, courses, "do not use"): the chain is the
//                request's own ladder (utils/approvalWorkflow.js: the steps above the current one)
//   Offers       an offer waiting to be approved (Offer being prepared): TL -> STL -> Managers -> Admin
//   Follow-ups   an open follow-up past its due day (not older than the Stale days of Step timing:
//                the imported backlog is left alone): owner -> TL -> STL -> Managers -> Admin
//   Recruiter's own misses (user, 2026-10-12: "reminder to the Recruiter AND the TL"; utils/missedItems.js):
//                overdue Tasks and personal to-dos, late next steps, interview feedback not recorded, "check by
//                recruiter" waiting, and (after the end-of-day time) calls due today that were not made. Same ladder:
//                the recruiter (level 0: "You missed 4 things yesterday: 3 follow-ups, 1 task. Open your list.") ->
//                the TL (level 1, the same run) -> STL -> Managers -> Admin. These go out from the morning time on
//                (settings: self.time) and not at all on a Sunday or a holiday. Switch: settings.self ("Also remind
//                the person themselves"), per channel.
//
// WHEN (settings pendingwork.settings → chain): each level has its own wait in hours since the
// item started waiting; the default is 0 for every level = the whole chain is told at once (at the
// next sweep, every 5 minutes), and again every day until the item is done. Stops by itself when
// the item is cleared. ONE reminder per item per level per day (pwr.sent.<day> → chain), and one
// grouped notice per person per run, never one per item.
//
// Messages are plain words and carry no candidate contact or pay. Bell always (if on), e-mail when
// the mail channel is set up. Test logins are never told by the real sweep.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const PW = require('./pendingWork');
const AS = require('./atsAlertSettings');
const M = require('./reportMailHtml');
const MI = require('./missedItems');

const HOUR = 3600000;
const DAY_MS = 86400000;
const isTest = (s) => PW.TEST_RE.test(String(s || ''));
const OFFER_PREPARED = 'Offer being prepared';
const LEVEL_WORDS = ['you', 'their team lead', 'their STL', 'their Manager', 'the Admin'];
const LABELS = {
  leave: 'leave request', regularization: 'attendance correction', latePermission: 'late-coming request', resignation: 'resignation',
  reward: 'recognition', course: 'course', document: 'document upload', courseMaterial: 'course material upload', ats_do_not_use: '"do not use" request',
};
const LINKS = {
  leave: '/leave', regularization: '/attendance', latePermission: '/attendance?tab=late', resignation: '/leave', reward: '/leave', course: '/leave', document: '/employee-services?tab=documents', courseMaterial: '/leave',
  ats_do_not_use: '/candidates',
};
const dur = (ms) => {
  const h = Math.max(0, Math.floor(ms / HOUR));
  if (h < 1) return 'less than an hour';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
};

// ---------------------------------------------------------------------------
// ITEMS — everything that is pending now, each with its chain of people.
//   { key, kind: 'approval'|'offer'|'followup', what, who, detail, since, link, levels: [[userId..]..], dept }
// ---------------------------------------------------------------------------
async function adminIds() {
  const us = await prisma.user.findMany({
    where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] },
    select: { id: true },
  });
  return us.map((u) => u.id);
}

async function collectItems({
  now = new Date(), settings = null, work = false, viewer = null, people = null, fresh = false, evening = null,
} = {}) {
  const st = settings || await PW.getSettings();
  const today = PW.dayOfIst(now);
  const items = [];
  const admins = await adminIds();
  // The recruiters' own misses need the pending-work directory (each recruiter's team lead). Only the run asks for it (work: true);
  // the dashboard's "Pending on my team" keeps the original sources and stays cheap.
  const W = work && (st.chain.followUps || st.chain.tasks || st.chain.steps) ? await MI.world({ viewer, people, fresh }) : null;
  const tlOfRecruiter = (id) => (W && W.rec.get(id) ? W.rec.get(id).tlId : null);
  const deptCache = new Map();
  const managersOf = async (dept) => {
    const k = String(dept || '');
    if (!deptCache.has(k)) {
      const { managers } = await PW.stlsAndManagers(dept);
      deptCache.set(k, managers.map((m) => m.id));
    }
    return deptCache.get(k);
  };

  // ---- 1. approvals (the workflow engine's own chain) --------------------------------------------
  if (st.chain.approvals) {
    const pending = await prisma.approvalStep.findMany({ where: { status: 'Pending' } });
    const ids = [...new Set(pending.map((s) => s.recordId))];
    const all = ids.length ? await prisma.approvalStep.findMany({ where: { recordId: { in: ids } }, orderBy: { seq: 'asc' } }) : [];
    const byRecord = new Map();
    all.forEach((s) => { const k = `${s.workflow}|${s.recordId}`; byRecord.set(k, [...(byRecord.get(k) || []), s]); });
    const leaveIds = pending.filter((s) => s.workflow === 'leave').map((s) => s.recordId);
    const lateIds = pending.filter((s) => s.workflow === 'latePermission').map((s) => s.recordId);
    const [leaves, lates] = await Promise.all([
      leaveIds.length ? prisma.leaveRequest.findMany({ where: { id: { in: leaveIds } }, select: { id: true, type: true, fromDate: true, toDate: true, status: true, employeeId: true, createdAt: true, reason: true, employee: { select: { employmentStatus: true } } } }) : [],
      lateIds.length ? prisma.latePermission.findMany({ where: { id: { in: lateIds } }, select: { id: true, date: true, expectedTime: true } }) : [],
    ]);
    // 2026-10-13 (HRMS item 8): only GENUINE pending leave is chased - a leaver's, a duplicate or a long-past request is not (utils/leaveGenuine.js).
    const notGenuine = leaves.length ? await require('./leaveGenuine').classify(leaves.filter((l) => l.status === 'Pending')) : new Map(); // eslint-disable-line global-require
    const leaveAfterHours = await leaveReminderHours();
    const leaveOf = new Map(leaves.map((l) => [l.id, l]));
    const lateOf = new Map(lates.map((l) => [l.id, l]));
    // EXIT APPROVALS (HRMS spec item 6): the current approver AND the Super Admin(s) are reminded once the step has waited the
    // "remind after N hours" of Exit settings (default 24), on working days only, once a day, until it is decided.
    const exitIds = pending.filter((x) => x.workflow === 'resignation').map((x) => x.recordId);
    const exitInfo = new Map();
    let exitCfg = null;
    let saIds = [];
    if (exitIds.length) {
      const EF = require('./exitFlow'); // eslint-disable-line global-require
      exitCfg = await EF.getSettings();
      saIds = (await EF.superAdmins({ allowTest: true })).map((u) => u.id);
      const recs = await prisma.employeeRecord.findMany({ where: { id: { in: exitIds } }, select: { id: true, date: true } });
      const dets = await prisma.resignationDetail.findMany({ where: { recordId: { in: exitIds } }, select: { recordId: true, reason: true, reasonOther: true, requestedLastWorkingDate: true } });
      const detOf = new Map(dets.map((d) => [d.recordId, d]));
      recs.forEach((r) => {
        const d = detOf.get(r.id) || {};
        exitInfo.set(r.id, { lwd: r.date || d.requestedLastWorkingDate || null, reason: d.reason === 'Other' && d.reasonOther ? d.reasonOther : (d.reason || null) });
      });
    }
    for (const cur of pending) {
      if (cur.workflow === 'leave' && leaveOf.has(cur.recordId) && (leaveOf.get(cur.recordId).status !== 'Pending' || notGenuine.has(cur.recordId))) continue; // eslint-disable-line no-continue
      const steps = byRecord.get(`${cur.workflow}|${cur.recordId}`) || [cur];
      const applicant = steps.find((s) => s.mode === 'applicant');
      const above = steps.filter((s) => s.seq > cur.seq && s.approverUserId && ['Waiting', 'Visibility', 'Pending'].includes(s.status));
      const seen = new Set([cur.approverUserId]);
      const levels = [cur.approverUserId ? [cur.approverUserId] : []];
      above.forEach((s) => { if (!seen.has(s.approverUserId)) { seen.add(s.approverUserId); levels.push([s.approverUserId]); } });
      const lv = leaveOf.get(cur.recordId);
      const lp = lateOf.get(cur.recordId);
      const detail = lv ? `${lv.type}, ${lv.fromDate}${lv.toDate && lv.toDate !== lv.fromDate ? ` to ${lv.toDate}` : ''}` : (lp ? `${lp.date}, by ${lp.expectedTime}` : null);
      // An old pending step with nobody at it (no approver) goes to the top of the ladder.
      if (!levels[0].length) levels[0] = admins;
      const isExit = cur.workflow === 'resignation' && !!exitCfg;
      const xi = isExit ? exitInfo.get(cur.recordId) : null;
      const exitLevels = isExit ? [levels[0], saIds.filter((id) => !levels[0].includes(id))].filter((l, i) => i === 0 || l.length) : null;
      items.push({
        key: `approval|${cur.workflow}|${cur.recordId}`,
        kind: 'approval',
        what: isExit ? 'exit approval' : (LABELS[cur.workflow] || cur.workflow),
        who: applicant ? applicant.approverName : (cur.workflow === 'ats_do_not_use' ? 'a recruiter' : 'someone'),
        waitingOn: cur.approverName || 'an approver',
        detail: isExit && xi ? `last working day ${xi.lwd || 'not set'}${xi.reason ? `, reason ${xi.reason}` : ''}` : detail,
        since: cur.activatedAt || cur.createdAt,
        link: isExit ? `/employee-services?tab=resignation&exit=${cur.recordId}` : (LINKS[cur.workflow] || '/leave'),
        levels: isExit ? exitLevels : levels,
        dept: cur.approverDepartment || null,
        ownerName: cur.approverName || null,
        // leave: reminded once older than the setting (default 24 h), the next level up after twice that, and so on (leave.reminder.afterHours)
        minWaitHours: cur.workflow === 'leave' ? leaveAfterHours : 0,
        ...(isExit ? { exit: true, exitWaitHours: exitCfg.reminderHours } : {}),
      });
    }
  }

  // ---- 2. offers waiting for approval ---------------------------------------------------------------
  if (st.chain.approvals) {
    const offers = await prisma.application.findMany({
      where: { offerStatus: OFFER_PREPARED, stage: { in: ['SELECTED', 'OFFER'] } },
      select: { id: true, updatedAt: true, candidate: { select: { name: true } }, requirement: { select: { title: true, department: true, tlId: true, stlId: true, client: { select: { name: true } } } } },
    });
    for (const a of offers) {
      const r = a.requirement || {};
      const levels = [];
      const used = new Set();
      const push = (ids) => { const fresh = ids.filter((i) => i && !used.has(i)); fresh.forEach((i) => used.add(i)); if (fresh.length) levels.push(fresh); };
      push([r.tlId]);
      push([r.stlId]);
      // eslint-disable-next-line no-await-in-loop
      push(await managersOf(r.department));
      push(admins);
      if (!levels.length) continue; // eslint-disable-line no-continue
      items.push({
        key: `offer|${a.id}`, kind: 'offer', what: 'offer to approve', who: a.candidate ? a.candidate.name : 'a candidate',
        waitingOn: 'the team lead', detail: `${r.title || 'Requirement'}${r.client ? ` (${r.client.name})` : ''}`, since: a.updatedAt, link: '/ats/offers', levels, dept: r.department || null,
      });
    }
  }

  // ---- 2b. client requests a Manager / Admin decides (delete, deactivate, owner change, merge, approval, close job, pause) -----
  if (st.chain.approvals) {
    try {
      const CR = require('./clientRequests'); // eslint-disable-line global-require
      const rows = await prisma.auditLog.findMany({ where: { action: { in: CR.ACTIONS }, approvalStatus: 'Pending' }, orderBy: { createdAt: 'desc' }, take: 300 });
      const reqIds = [...new Set(rows.filter((r) => r.entity === 'Requirement').map((r) => r.entityId))];
      const reqs = reqIds.length ? await prisma.requirement.findMany({ where: { id: { in: reqIds } }, select: { id: true, clientId: true, title: true } }) : [];
      const reqById = new Map(reqs.map((r) => [r.id, r]));
      const cids = [...new Set(rows.map((r) => (r.entity === 'Client' ? r.entityId : (reqById.get(r.entityId) || {}).clientId)).filter(Boolean))];
      const cls = cids.length ? await prisma.client.findMany({ where: { id: { in: cids } }, select: { id: true, name: true, ownerDepartment: true } }) : [];
      const clById = new Map(cls.map((c) => [c.id, c]));
      for (const r of rows) {
        const kind = CR.kindOfAction(r.action);
        const req = r.entity === 'Requirement' ? reqById.get(r.entityId) : null;
        const client = clById.get(req ? req.clientId : r.entityId);
        if (!kind || !client) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const deciders = await CR.deciderIds(client, CR.KINDS[kind].decider);
        const levels = [];
        const used = new Set();
        const push = (ids) => { const fresh = ids.filter((i) => i && !used.has(i)); fresh.forEach((i) => used.add(i)); if (fresh.length) levels.push(fresh); };
        push(deciders.filter((i) => !admins.includes(i)));
        push(admins);
        if (!levels.length) continue; // eslint-disable-line no-continue
        items.push({
          key: `creq|${r.id}`, kind: 'approval', what: `${CR.KINDS[kind].label.toLowerCase()} request`, who: r.actorName || 'a BDE',
          waitingOn: levels[0].length > 1 ? 'the Manager / Admin' : 'the approver', detail: `${client.name}${req ? `, requirement ${req.title}` : ''}`,
          since: r.createdAt, link: '/clients', levels, dept: client.ownerDepartment || null,
        });
      }
    } catch (err) { console.error('[chainAlerts] client requests:', err.message); } // eslint-disable-line no-console
  }

  // ---- 2c. client follow-ups / meetings of the BDE (utils/clientBusiness.js: AppSetting clientfu.<client>.<id>) ------------------
  if (st.chain.followUps) {
    try {
      const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'clientfu.' } } });
      const open = rows.map((r) => { try { return { ...JSON.parse(r.value), _key: r.key }; } catch { return null; } })
        .filter((x) => x && x.status === 'Open' && x.dueDate && x.dueDate < today && ['followup', 'meeting'].includes(x.kind));
      if (open.length) {
        const cids = [...new Set(open.map((x) => x.clientId))];
        const cls = await prisma.client.findMany({ where: { id: { in: cids } }, select: { id: true, name: true, bdeOwner: true, secondaryBde: true, ownerDepartment: true } });
        const clById = new Map(cls.map((c) => [c.id, c]));
        const tls = await require('./clientBdes').bdeTlIds(); // eslint-disable-line global-require
        for (const x of open) {
          const client = clById.get(x.clientId);
          if (!client) continue; // eslint-disable-line no-continue
          const late = PW.daysBetween(x.dueDate, today);
          if (late > (AS.alertSettingsNow().staleAfterDays || 30)) continue; // eslint-disable-line no-continue
          // eslint-disable-next-line no-await-in-loop
          const owners = await require('./clientBdes').ownerBdeIds({ clientId: client.id, client }); // eslint-disable-line global-require
          const levels = [];
          const used = new Set();
          const push = (ids) => { const fresh = ids.filter((i) => i && !used.has(i)); fresh.forEach((i) => used.add(i)); if (fresh.length) levels.push(fresh); };
          push(owners);
          push(tls);
          // eslint-disable-next-line no-await-in-loop
          push(await managersOf(client.ownerDepartment));
          push(admins);
          items.push({
            key: `clientfu|${x._key}`, kind: 'followup', what: 'client follow-up', who: x.ownerName || client.bdeOwner || 'the BDE',
            waitingOn: x.ownerName || client.bdeOwner || 'the BDE', detail: `${client.name}: ${x.title || (x.kind === 'meeting' ? 'Meeting' : 'Follow-up')}; ${late} day${late === 1 ? '' : 's'} late`,
            since: new Date(new Date(`${x.dueDate}T00:00:00+05:30`).getTime() + DAY_MS), link: `/clients/${client.id}`, levels, dept: client.ownerDepartment || null,
          });
        }
      }
    } catch (err) { console.error('[chainAlerts] client follow-ups:', err.message); } // eslint-disable-line no-console
  }

  // ---- 3. follow-ups past their due day ---------------------------------------------------------------
  if (st.chain.followUps) {
    const stale = AS.alertSettingsNow().staleAfterDays || 30;
    const from = new Date(new Date(`${today}T00:00:00Z`).getTime() - stale * DAY_MS).toISOString().slice(0, 10);
    const fus = await prisma.applicationFollowUp.findMany({
      where: { completedAt: null, dueDate: { lt: today, gte: from }, application: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } } },
      select: {
        id: true, ownerUserId: true, ownerName: true, tlUserId: true, stlUserId: true, nextAction: true, purpose: true, dueDate: true,
        application: { select: { candidate: { select: { name: true } }, requirement: { select: { title: true, department: true, internal: true } } } },
      },
      take: 3000,
    });
    for (const f of fus) {
      const r = (f.application && f.application.requirement) || {};
      const levels = [];
      const used = new Set();
      const push = (ids) => { const fresh = ids.filter((i) => i && !used.has(i)); fresh.forEach((i) => used.add(i)); if (fresh.length) levels.push(fresh); };
      push([f.ownerUserId]);
      push([f.tlUserId || tlOfRecruiter(f.ownerUserId)]);
      push([f.stlUserId]);
      // eslint-disable-next-line no-await-in-loop
      push(await managersOf(r.department));
      push(admins);
      if (levels.length <= 1 && !f.ownerUserId) continue; // eslint-disable-line no-continue
      const late = Math.max(1, PW.daysBetween(String(f.dueDate).slice(0, 10), today));
      items.push({
        key: `followup|${f.id}`, kind: 'followup', what: 'follow-up', who: f.ownerName || 'nobody named',
        waitingOn: f.ownerName || 'the owner', detail: `${f.purpose || f.nextAction || 'Follow-up'} — ${f.application && f.application.candidate ? f.application.candidate.name : 'candidate'}${r.title ? `, ${r.title}` : ''}; ${late} day${late === 1 ? '' : 's'} late`,
        since: new Date(new Date(`${String(f.dueDate).slice(0, 10)}T00:00:00+05:30`).getTime() + DAY_MS), link: '/ats/team?view=followups', levels, dept: r.department || null, ownerName: f.ownerName,
        work: !!W, mkind: 'followup', ownerId: f.ownerUserId, dueDay: String(f.dueDate).slice(0, 10),
      });
    }
  }

  // ---- 4. the recruiter's own misses: tasks / to-dos, late steps, feedback not recorded, check waiting, calls not made --------------
  if (W) {
    const evenIng = evening === null ? PW.hhmmOfIst(now) >= st.eod.time : !!evening;
    const bulk = await MI.collectBulk({ rec: W.rec, today, settings: st, evening: evenIng, now });
    const stls = new Map();
    const above = async (dept) => {
      const k = String(dept || '');
      if (!stls.has(k)) {
        const { stls: a, managers } = await PW.stlsAndManagers(dept);
        stls.set(k, { stl: a.map((u) => u.id), mgr: managers.map((u) => u.id) });
      }
      return stls.get(k);
    };
    for (const it of bulk) {
      const rec = W.rec.get(it.ownerId) || {};
      // eslint-disable-next-line no-await-in-loop
      const up = await above(rec.department || it.dept);
      const dayStart = new Date(new Date(`${it.dueDay}T00:00:00+05:30`).getTime() + (it.kind === 'call' ? 0 : DAY_MS));
      items.push({
        key: it.key, kind: 'followup', work: true, mkind: it.kind, title: it.title, what: MI.KIND[it.kind].one, who: it.ownerName || 'the recruiter', waitingOn: it.ownerName || 'the recruiter',
        detail: it.detail, since: dayStart, link: it.link, dept: rec.department || it.dept || null, ownerName: it.ownerName, ownerId: it.ownerId, dueDay: it.dueDay,
        // level 0 the recruiter, 1 their team lead (empty when nobody could be found: the level stays so the STL is still level 2), then the STL, the Managers, the Admin
        levels: [[it.ownerId], rec.tlId ? [rec.tlId] : [], up.stl, up.mgr, admins],
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// ONE RUN
// ---------------------------------------------------------------------------
// Setting: AppSetting leave.reminder.afterHours (default 24): a leave request is chased only once it has waited this long.
async function leaveReminderHours() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'leave.reminder.afterHours' } });
    const n = row ? Number(JSON.parse(row.value)) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 720 ? n : 24;
  } catch { return 24; }
}

const REG_KEY = 'pwr.chain';
let RUNNING = false;

// The recruiter's OWN notice goes out on the channels "Also remind the person themselves" allows: the bell, and e-mail / WhatsApp /
// SMS only when that channel is really connected AND switched on there. (Everyone else keeps PW.deliver.)
async function deliverSelf({ settings, user, title, bell, text, html, openPath, key, mailer, testMode, out, msgSend }) {
  const s = settings.self;
  const res = { bell: false, email: null, whatsapp: null, sms: null };
  const test = isTest(user.name + ' ' + user.email);
  if (test && !testMode) { res.email = 'test login - nothing sent'; return res; }
  if (s.bell) {
    await prisma.notification.create({ data: { userId: user.id, title, message: bell + (openPath ? '\nOpen: ' + openPath : ''), channel: 'In-App', recipient: key || null, status: 'Delivered' } });
    res.bell = true;
    out.bell = (out.bell || 0) + 1;
  }
  const MS = require('./messaging'); // eslint-disable-line global-require
  const status = await MS.channelStatus().catch(() => ({}));
  if (s.email) {
    if (!user.email) res.email = 'no e-mail address';
    else if (!mailer && !(status.Email && status.Email.configured)) res.email = 'not connected';
    else {
      const send = mailer || require('./mailer').sendMail; // eslint-disable-line global-require
      const r = await send({ to: user.email, subject: 'TeamLink - ' + title, text, html, useEmployeeFrom: false, fromName: 'TeamLink Reports' });
      res.email = r.ok ? 'sent' : (r.notConfigured ? 'not sent - e-mail is not set up' : 'not sent - ' + String(r.error || '').slice(0, 120));
      await prisma.notification.create({ data: { userId: user.id, title, message: text.slice(0, 1500), channel: 'Email', recipient: user.email, status: r.ok ? 'Sent' : res.email, read: true } });
      if (r.ok) out.emails = (out.emails || 0) + 1; else out.emailsNotSent = (out.emailsNotSent || 0) + 1;
    }
  } else res.email = 'off';
  const phone = (await prisma.employee.findFirst({ where: { userId: user.id }, select: { phone: true } }).catch(() => null) || {}).phone;
  const short = bell.replace(/\s+/g, ' ').slice(0, 300);
  for (const [ch, k] of [['WhatsApp', 'whatsapp'], ['SMS', 'sms']]) {
    if (!s[k]) { res[k] = 'off'; continue; } // eslint-disable-line no-continue
    if (!msgSend && !(status[ch] && status[ch].configured)) { res[k] = 'not connected'; continue; } // eslint-disable-line no-continue
    if (!phone) { res[k] = 'no phone on the profile'; continue; } // eslint-disable-line no-continue
    if (test && !msgSend) { res[k] = 'test login - nothing sent'; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const r = await (msgSend || MS.send)(ch, { to: phone, kind: 'staff', text: short });
    res[k] = r.ok ? 'sent' : 'not sent - ' + String(r.error || r.outcome || '').slice(0, 100);
    if (r.ok) out[k === 'whatsapp' ? 'whatsapps' : 'smss'] = (out[k === 'whatsapp' ? 'whatsapps' : 'smss'] || 0) + 1;
  }
  return res;
}

async function run({
  now = new Date(), dryRun = false, force = false, mailer = null, testMode = false, keys = null,
  viewer = null, people = null, quiet = false, evening = null, work = true, fresh = false, msgSend = null,
} = {}) {
  const settings = await PW.getSettings({ fresh: true });
  const day = PW.dayOfIst(now);
  const out = { day, dryRun, items: 0, toTell: 0, people: 0, recruiters: 0, tlPeople: 0, bell: 0, emails: 0, emailsNotSent: 0, byKind: {}, skipped: null };
  if (!(settings.enabled && settings.chain.enabled) && !force) return { ...out, skipped: 'The pending-approval alerts are switched off.' };
  if (RUNNING && !dryRun) return { ...out, skipped: 'already running' };
  RUNNING = !dryRun;
  try {
    const off = await PW.offDayReason(day);
    const hhmm = PW.hhmmOfIst(now);
    // 2026-10-13: HR is reminded when leave has not been synced with Pulse for over 7 days. Only reached when the master switch is ON (above).
    if (!dryRun && !off && !keys && !testMode) await require('./pulseSync').maybeRemindHr({ now }).catch(() => null); // eslint-disable-line global-require
    // A run for named items only (tests, a re-send) reads the recruiters' world just when one of them is a recruiter's own work.
    const all = await collectItems({ now, settings, work: work && (!keys || keys.some((k) => MI.WORK_KEY.test(k))), viewer, people, fresh, evening });
    const items = keys ? all.filter((i) => keys.includes(i.key)) : all;
    out.items = items.length;
    const reg = await PW.locked(async () => {
      const row = await prisma.appSetting.findUnique({ where: { key: REG_KEY } }).catch(() => null);
      try { return row && row.value ? JSON.parse(row.value) : {}; } catch { return {}; }
    });
    const sent = await PW.readSent(day);
    const hours = settings.chain.levelHours;
    const maxLevel = settings.chain.maxLevel;
    const per = new Map(); // userId -> { own: [], above: [] }
    const claims = [];
    for (const it of items) {
      const waited = now.getTime() - new Date(it.since || now).getTime();
      const firstTime = !reg[it.key];
      // The recruiter's own work (follow-ups, tasks, late steps, feedback, calls): nothing on a Sunday or a holiday at all, and from the
      // morning time on (the morning after), not at midnight. Approvals keep their own rule below.
      if (it.work) {
        if (off && !force) continue; // eslint-disable-line no-continue
        if (quiet && !force && hhmm < settings.self.time) continue; // eslint-disable-line no-continue
      }
      // On a Sunday / holiday only items never told about before go out (the repeat waits for a working day).
      if (it.exit && off && !force) continue; // eslint-disable-line no-continue
      if (off && !force && !firstTime) continue; // eslint-disable-line no-continue
      if (!firstTime && !settings.chain.repeatDaily) continue; // eslint-disable-line no-continue
      it.levels.slice(0, it.exit ? 2 : maxLevel + 1).forEach((ids, lvl) => {
        if (it.exit ? waited < it.exitWaitHours * HOUR : waited < Math.max((hours[lvl] || 0), (it.minWaitHours || 0) * (lvl + 1)) * HOUR) return;
        const claimKey = it.key + '|L' + lvl;
        if (sent.chain && sent.chain[claimKey]) return;
        // "Also remind the person themselves" off: the team lead and above are still told, the recruiter is not.
        if (lvl === 0 && it.work && !settings.self.enabled) { claims.push(claimKey); return; }
        ids.forEach((uid) => {
          const e = per.get(uid) || { own: [], above: [] };
          (lvl === 0 ? e.own : e.above).push({ it, lvl, waited });
          per.set(uid, e);
        });
        claims.push(claimKey);
        out.byKind[it.mkind || it.kind] = (out.byKind[it.mkind || it.kind] || 0) + 1;
      });
    }
    out.toTell = claims.length;
    const users = await PW.usersById([...per.keys()]);
    out.people = per.size;
    const win = await MI.windowOf(day);
    // The words, one place: used by the real run and by the dry run.
    const noticeOf = (uid, e) => {
      const u = users.get(uid) || {};
      const line = (x) => {
        const i = x.it;
        if (i.work && x.lvl === 0) return '• ' + i.detail;
        const who = i.kind === 'approval' ? i.who + "'s " + i.what + (i.detail ? ' (' + i.detail + ')' : '') : (i.kind === 'offer' ? 'Offer for ' + i.who + ' (' + i.detail + ')' : i.who + ': ' + i.detail);
        const wait = i.kind === 'approval' ? 'waiting for ' + i.waitingOn + ' for ' + dur(x.waited) : (i.kind === 'offer' ? 'waiting to be approved for ' + dur(x.waited) : '');
        return '• ' + who + (wait ? ' - ' + wait : '');
      };
      e.own.sort((a, b) => b.waited - a.waited);
      e.above.sort((a, b) => b.waited - a.waited);
      const ownWork = e.own.filter((x) => x.it.work);
      const aboveWork = e.above.filter((x) => x.it.work);
      // the words (utils/missedItems.js) count by the real kind: follow-up, task, late step, feedback, check, call
      const asKind = (list) => list.map((x) => ({ ...x.it, kind: x.it.mkind || x.it.kind }));
      const lines = [];
      if (ownWork.length) lines.push(MI.selfSummary(asKind(ownWork), win), '');
      if (aboveWork.length) {
        const ts = MI.teamSummary(asKind(aboveWork), win);
        lines.push(ts.head, ...ts.who.slice(0, 8).map((w) => '• ' + w), '');
      }
      if (e.own.length) lines.push('Waiting for YOU:', ...e.own.slice(0, 6).map(line), ...(e.own.length > 6 ? ['... and ' + (e.own.length - 6) + ' more'] : []), '');
      if (e.above.length) lines.push('Waiting on the people under you:', ...e.above.slice(0, 8).map(line), ...(e.above.length > 8 ? ['... and ' + (e.above.length - 8) + ' more'] : []), '');
      const first = (e.own[0] || e.above[0]).it;
      const ownOnlyWork = ownWork.length > 0 && ownWork.length === e.own.length && !e.above.length;
      const title = ownOnlyWork ? 'You missed ' + MI.plural(ownWork.length, 'thing', 'things')
        : (!e.own.length && aboveWork.length === e.above.length) ? 'Your team missed ' + MI.plural(aboveWork.length, 'thing', 'things')
          : e.own.length && e.above.length ? e.own.length + ' waiting for you, ' + e.above.length + ' waiting on your people'
            : e.own.length ? e.own.length + ' ' + (e.own.length === 1 ? 'thing is' : 'things are') + ' waiting for you'
              : e.above.length + ' ' + (e.above.length === 1 ? 'thing is' : 'things are') + ' waiting on your people';
      // The recruiter's link is their own list (the dashboard box); a team lead's is the team's pending work.
      const link = ownOnlyWork ? '/ats/dashboard#missed-items' : first.link;
      const text = lines.join('\n') + 'Open: ' + PW.absolute(link);
      const html = M.page(title, (ownWork.length ? M.p(MI.selfSummary(asKind(ownWork), win)) : '')
        + (aboveWork.length ? M.p(MI.teamSummary(asKind(aboveWork), win).head) : '')
        + (e.own.length ? M.h2('Waiting for you') + M.table(['What', 'Waiting'], e.own.slice(0, 10).map((x) => [x.it.work ? x.it.detail : (x.it.kind === 'approval' ? x.it.who + ': ' + x.it.what + (x.it.detail ? ' (' + x.it.detail + ')' : '') : (x.it.kind === 'offer' ? 'Offer for ' + x.it.who : x.it.who + ': ' + x.it.detail)), dur(x.waited)])) : '')
        + (e.above.length ? M.h2('Waiting on the people under you') + M.table(['What', 'With', 'Waiting'], e.above.slice(0, 15).map((x) => [x.it.kind === 'approval' ? x.it.who + ': ' + x.it.what + (x.it.detail ? ' (' + x.it.detail + ')' : '') : (x.it.kind === 'offer' ? 'Offer for ' + x.it.who : x.it.detail), x.it.waitingOn, dur(x.waited)])) : '')
        + M.button(PW.absolute(link), ownOnlyWork ? 'Open your list' : 'Open'));
      const bell = lines.filter(Boolean).slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, 300);
      return { u, title, text, html, bell, link, ownOnlyWork, ownWork, aboveWork, first };
    };
    if (dryRun) {
      let sample = null;
      per.forEach((e, uid) => {
        if (e.own.some((x) => x.it.work)) out.recruiters += 1;
        if (e.above.some((x) => x.it.work && x.lvl === 1)) out.tlPeople += 1;
      });
      out.preview = [...per.entries()].slice(0, 20).map(([uid, e]) => ({ to: (users.get(uid) || {}).name || uid, forYou: e.own.length, onYourTeam: e.above.length }));
      sample = { recruiter: null, tl: null };
      for (const [uid, e] of per.entries()) {
        if (!sample.recruiter && e.own.some((x) => x.it.work)) sample.recruiter = { to: (users.get(uid) || {}).name || uid, title: noticeOf(uid, e).title, text: noticeOf(uid, e).text };
        if (!sample.tl && e.above.some((x) => x.it.work && x.lvl === 1)) sample.tl = { to: (users.get(uid) || {}).name || uid, title: noticeOf(uid, e).title, text: noticeOf(uid, e).text };
      }
      out.sample = sample;
      return out;
    }
    for (const [uid, e] of per.entries()) {
      const u = users.get(uid);
      if (!u || (!testMode && isTest(u.name + ' ' + u.email))) continue; // eslint-disable-line no-continue
      const n = noticeOf(uid, e);
      if (n.ownWork.length) out.recruiters += 1;
      if (e.above.some((x) => x.it.work && x.lvl === 1)) out.tlPeople += 1;
      // eslint-disable-next-line no-await-in-loop
      if (n.ownOnlyWork) await deliverSelf({ settings, user: u, title: n.title, bell: n.bell, text: n.text, html: n.html, openPath: n.link, key: 'pwr|chain|' + day, mailer, testMode, out, msgSend });
      // eslint-disable-next-line no-await-in-loop
      else await PW.deliver({ settings, user: u, title: n.title, bell: n.bell, text: n.text, html: n.html, openPath: n.first.link, key: 'pwr|chain|' + day, mailer, dryRun: false, testMode, out });
    }
    // Remember: what was told today (once per item per level per day) and what has ever been told (for the Sunday rule); forget cleared items.
    await PW.locked(async () => {
      const s = await PW.readSent(day);
      s.chain = s.chain || {};
      claims.forEach((k) => { s.chain[k] = 1; });
      const key = PW.SENT_PREFIX + day;
      const value = JSON.stringify(s);
      await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
      const live = new Set(all.map((i) => i.key));
      const next = {};
      Object.keys(reg).forEach((k) => { if (live.has(k)) next[k] = reg[k]; });
      items.forEach((i) => { if (!next[i.key] && claims.some((c) => c.startsWith(i.key + '|'))) next[i.key] = { first: new Date().toISOString() }; });
      const v2 = JSON.stringify(next);
      await prisma.appSetting.upsert({ where: { key: REG_KEY }, update: { value: v2 }, create: { key: REG_KEY, value: v2 } });
    });
    return out;
  } finally {
    if (!dryRun) RUNNING = false;
  }
}

// ---------------------------------------------------------------------------
// "PENDING ON MY TEAM" — what the dashboard shows a TL / STL / Manager: who is waiting and since when.
//   mine   items waiting for the viewer (level 0)
//   team   items waiting on people under the viewer (level 1+ includes the viewer)
// ---------------------------------------------------------------------------
let VIEW_CACHE = { at: 0, items: null };
async function chainView(user, { fresh = false } = {}) {
  if (fresh || !VIEW_CACHE.items || Date.now() - VIEW_CACHE.at > 60000) {
    VIEW_CACHE = { at: Date.now(), items: await collectItems({}) };
  }
  const now = Date.now();
  const rows = [];
  VIEW_CACHE.items.forEach((it) => {
    const idx = it.levels.findIndex((ids) => ids.includes(user.id));
    if (idx < 0) return;
    const waited = now - new Date(it.since || now).getTime();
    rows.push({
      id: it.key, kind: it.kind, mine: idx === 0, level: idx, what: it.what, who: it.who, waitingOn: it.waitingOn, detail: it.detail,
      since: it.since, waited: dur(waited), waitedHours: Math.floor(waited / HOUR), link: it.link,
      text: it.kind === 'approval' ? `${it.who}: ${it.what}${it.detail ? ` (${it.detail})` : ''}` : (it.kind === 'offer' ? `Offer for ${it.who} (${it.detail})` : `${it.who}: ${it.detail}`),
    });
  });
  rows.sort((a, b) => (Number(b.mine) - Number(a.mine)) || (b.waitedHours - a.waitedHours));
  return { rows, mine: rows.filter((r) => r.mine).length, team: rows.filter((r) => !r.mine).length };
}

module.exports = { collectItems, run, chainView, LEVEL_WORDS, leaveReminderHours };
