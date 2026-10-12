// ---------------------------------------------------------------------------
// REQUIREMENT REQUESTS (per-role spec 2026-10-03).
//
// A BDE may no longer CREATE a job, and a CLIENT asks for new hiring from the
// portal. Both hold 'Requirement Request' / create (permissions.js), and both
// land here. A request is an ordinary Requirement saved as DRAFT — no schema
// change — that is NOT live, is never posted to the Job Portal and needs a
// lead to open it (Requirement Detail / approve -> POST /requirements/:id/
// activate, the same agreement gate as every other job). An audit row
// "Requirement requested" records who asked; the leads who may activate are
// told by a notification.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { notifyUsers } = require('./notify');
const { bdeDirectory } = require('./bdeSeats');
const { canonicalDepartment } = require('./bdeDesk');

// Test logins are never told about real requests - except in the TEST SANDBOX
// (TEST_MODE=1), where the test fixtures ARE the people being notified.
const TEST_RE = /zztest|example\.test/i;
const TEST_MARK = { test: (s) => !process.env.TEST_MODE && TEST_RE.test(s) };
// The pop-up's notification title prefix (routes/admin.js GET /notifications/popups).
const POPUP_TITLE = 'New job request from ';
// "When do you need them?" (the portal form's four plain choices) -> the job's
// joining timeline and priority.
const JOIN_BY = {
  asap: { joiningTimeline: 'Immediate', priority: 'High' },
  '15': { joiningTimeline: 'Within 15 Days', priority: 'High' },
  '30': { joiningTimeline: 'Within 30 Days', priority: 'Medium' },
  later: { joiningTimeline: '30–60 Days', priority: 'Low' },
};
// The portal form asks for the salary per MONTH in rupees (what a client knows);
// the job stores it the way every job here does, in lakh per year: ₹1.8L - ₹3L.
// A plain "salary" text (a BDE typing it) is kept as written.
const lakh = (monthly) => String(Math.round((monthly * 12 / 100000) * 100) / 100);
const rupees = (n) => Number(n).toLocaleString('en-IN');
function salaryFrom(b) {
  const lo = Number(b.salaryMonthlyMin);
  const hi = Number(b.salaryMonthlyMax);
  const okLo = Number.isFinite(lo) && lo > 0;
  const okHi = Number.isFinite(hi) && hi > 0;
  if (!okLo && !okHi) return { band: clean(b.salary, 120), note: null };
  const band = okLo && okHi ? `₹${lakh(lo)}L - ₹${lakh(hi)}L` : (okLo ? `₹${lakh(lo)}L+` : `up to ₹${lakh(hi)}L`);
  const asked = okLo && okHi ? `₹${rupees(lo)} to ₹${rupees(hi)}` : (okLo ? `from ₹${rupees(lo)}` : `up to ₹${rupees(hi)}`);
  return { band, note: `Client asked for ${asked} a month` };
}
const clean = (v, max = 4000) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

async function nextCode() {
  const used = await prisma.requirement.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `REQ-${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.requirement.findFirst({ where: { reqCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `REQ-${Date.now()}`;
}

// Who hears about a request: Super Admin / Admin, and the Managers of the
// client's department. Test logins are never picked (agent-rules LESSON).
async function approversFor(department) {
  const users = await prisma.user.findMany({
    where: {
      status: { not: 'Inactive' },
      OR: [
        { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        ...(department ? [{ atsRole: 'MANAGER', OR: [{ atsDepartment: department }, { atsScopeDepartments: { contains: department } }] }] : []),
      ],
    },
    select: { id: true, name: true, email: true },
  });
  return users.filter((u) => !TEST_MARK.test(`${u.name} ${u.email}`)).map((u) => u.id);
}

// WHO HEARS ABOUT A REQUEST (user, 2026-10-09). In this order:
//   1. the client's BDE (Client.bdeOwner) and the second BDE — they own the client;
//   2. no BDE named on the client -> the BDEs of the client's desk (EDU -> Education …);
//   3. the BDE TL(s) — they see every client;
//   4. Super Admin / Admin and the department Managers (they can open the job).
// `owner` is the person the client is told it was sent to (1, else a desk BDE).
async function requestRecipients(client, department) {
  const dir = await bdeDirectory();
  const named = [client.bdeOwner, client.secondaryBde].filter(Boolean).map((n) => dir.infoFor(n)).filter((i) => i && i.userId);
  const desk = canonicalDepartment(client.ownerDepartment || department);
  const deskBdes = named.length ? [] : dir.all().filter((i) => i.userId && i.active && !i.isTl && i.desk && i.desk === desk);
  const tls = dir.all().filter((i) => i.userId && i.active && i.isTl);
  const approvers = await approversFor(department);
  const owner = named[0] || (deskBdes.length === 1 ? deskBdes[0] : null);
  const ids = [...named, ...deskBdes, ...tls].map((i) => i.userId);
  // Test logins are never picked (agent-rules LESSON); real people only.
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, status: { not: 'Inactive' } }, select: { id: true, name: true, email: true } }) : [];
  const real = new Set(users.filter((u) => !TEST_MARK.test(`${u.name} ${u.email}`)).map((u) => u.id));
  // popupIds = the BDE side (the client's BDE + second BDE, or the desk's BDEs, and the
  // BDE TL): they get the pop-up on screen. The Admins / Managers keep the bell only.
  const popupIds = [...new Set(ids.filter((i) => real.has(i)))];
  return { userIds: [...new Set([...popupIds, ...approvers])], popupIds, owner, named, deskBdes };
}

// body: { title, clientId, department, openings, location, skills, experience,
//         jobDescription, salary, closingDate, notes }
// by:   { user, via: 'BDE' | 'Client portal' }
async function createRequirementRequest(body, { user, via }) {
  const b = body || {};
  const title = clean(b.title, 200);
  if (!title) return { status: 400, body: { error: 'Enter the job title you need.', field: 'title' } };
  const client = await prisma.client.findUnique({ where: { id: String(b.clientId || '') } });
  if (!client) return { status: 400, body: { error: 'Pick the client this job is for.', field: 'clientId' } };
  // A paused / archived client takes no new work (utils/clientLifecycle.js,
  // when present).
  try {
    // eslint-disable-next-line global-require
    const lc = require('./clientLifecycle');
    const refusal = lc && lc.newWorkRefusal ? lc.newWorkRefusal(client, 'a new requirement request') : null;
    if (refusal) return { status: 409, body: refusal };
  } catch { /* lifecycle helper not installed */ }
  const openings = Math.max(1, Math.min(500, Number(b.openings) || 1));
  const department = clean(b.department, 80) || client.ownerDepartment || null;
  const salary = salaryFrom(b);
  const notes = [clean(b.notes, 2000), salary.note].filter(Boolean).join(' · ') || null;
  const jd = clean(b.jobDescription, 8000);
  // The BDE who owns this client (named on it) owns the request too, so it lands
  // in their Jobs list ("Waiting for you"); a client with no BDE named leaves it
  // to the desk's BDEs / BDE TL / Manager.
  const who = await requestRecipients(client, department);
  const namedOwner = who.named[0] && who.named[0].userId ? who.named[0].userId : null;
  // A department with ONE team lead: the job is theirs from the start (default TL).
  const dtl = require('./defaultTeamLead'); // eslint-disable-line global-require
  await dtl.prime();
  const autoTl = dtl.defaultFor(department);
  const created = await prisma.requirement.create({
    data: {
      title,
      ...(autoTl ? { tlId: autoTl.id, tl: autoTl.name } : {}),
      clientId: client.id,
      department,
      openings,
      location: clean(b.location, 200),
      skills: clean(b.skills, 1000),
      experience: clean(b.experience, 40),
      jobDescription: jd,
      salary: salary.band,
      closingDate: clean(b.closingDate, 20),
      description: [jd, notes ? `Request note: ${notes}` : null].filter(Boolean).join('\n\n') || title,
      internal: false,
      hiringType: 'Client Placement',
      status: 'DRAFT',
      priority: (JOIN_BY[String(b.joinBy || '')] || {}).priority || 'Medium',
      ...(JOIN_BY[String(b.joinBy || '')] ? { joiningTimeline: JOIN_BY[String(b.joinBy)].joiningTimeline } : {}),
      reqCode: await nextCode(),
      // The client's own BDE owns the job - also when the BDE TL files it for them.
      bdeId: namedOwner || (via === 'BDE' ? user.id : null),
    },
  });
  if (autoTl) {
    await logAudit({ userId: user.id, actorName: user.name || null, action: 'Default team lead set', entity: 'Requirement', entityId: created.id, toValue: autoTl.name, reason: `Automatic: ${department} has one team lead` });
  }
  await logAudit({
    userId: user.id, actorName: user.name || null, action: 'Requirement requested', entity: 'Requirement',
    entityId: created.id, toValue: `DRAFT — requested via ${via}`, reason: notes || undefined,
  });
  // THE POP-UP (user, 2026-10-09): the client's BDE(s) and the BDE TL get a pop-up on
  // their screen (components/JobRequestPopup.jsx, polling GET /admin/notifications/
  // popups) - its row is this notification, titled "New job request from <Client>"
  // and ending in the "Open:" line; each person's own row is acknowledged by them
  // alone (PATCH /admin/notifications/:id/read). Admins / Managers: the bell only.
  const popupSet = new Set(who.popupIds);
  const openLine = `\nOpen: /requirements/${created.id}`;
  await notifyUsers(who.popupIds, {
    title: `${POPUP_TITLE}${client.name}`,
    message: `${title}, ${openings} opening${openings === 1 ? '' : 's'}. ${client.name} sent this request${via === 'Client portal' ? ' from the client portal' : ` through ${user.name || 'a BDE'}`}. Open it, fill in the rest and post it.${openLine}`,
    exceptUserId: user.id,
  }).catch(() => null);
  await notifyUsers(who.userIds.filter((id) => !popupSet.has(id)), {
    title: `New job request — ${created.reqCode}`,
    message: `${client.name} asks for ${title} (${openings} opening${openings === 1 ? '' : 's'}), sent via ${via} by ${user.name || 'a user'}. Find it in Jobs (status Draft), check it, then press Open job.${openLine}`,
    exceptUserId: user.id,
  }).catch(() => null);
  // What the sender is told: who it went to and what happens next, in plain words.
  const sentTo = who.owner ? { name: who.owner.name, position: who.owner.position, label: who.owner.label } : null;
  const message = via === 'BDE'
    ? `Request ${created.reqCode} saved as a Draft in Jobs. Open it, fill in the rest and press Save & Post.`
    : sentTo
      ? `Sent to ${sentTo.label}. We'll confirm soon.`
      : `Sent to the TeamLink team (${client.ownerDepartment || department || 'your'} desk). We'll confirm soon.`;
  return {
    status: 201,
    body: {
      ok: true, id: created.id, reqCode: created.reqCode, status: 'DRAFT', sentTo, message,
      next: 'TeamLink checks the request and opens the job. You will see its status in My Requirements.',
    },
  };
}

module.exports = { createRequirementRequest, POPUP_TITLE };
