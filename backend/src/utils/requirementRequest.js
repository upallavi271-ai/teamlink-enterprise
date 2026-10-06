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

const TEST_MARK = /zztest|example\.test/i;
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
  const notes = clean(b.notes, 2000);
  const jd = clean(b.jobDescription, 8000);
  const created = await prisma.requirement.create({
    data: {
      title,
      clientId: client.id,
      department,
      openings,
      location: clean(b.location, 200),
      skills: clean(b.skills, 1000),
      experience: clean(b.experience, 40),
      jobDescription: jd,
      salary: clean(b.salary, 120),
      closingDate: clean(b.closingDate, 20),
      description: [jd, notes ? `Request note: ${notes}` : null].filter(Boolean).join('\n\n') || title,
      internal: false,
      hiringType: 'Client Placement',
      status: 'DRAFT',
      priority: 'Medium',
      reqCode: await nextCode(),
      bdeId: via === 'BDE' ? user.id : null,
    },
  });
  await logAudit({
    userId: user.id, actorName: user.name || null, action: 'Requirement requested', entity: 'Requirement',
    entityId: created.id, toValue: `DRAFT — requested via ${via}`, reason: notes || undefined,
  });
  await notifyUsers(await approversFor(department), {
    title: `New requirement request — ${created.reqCode}`,
    message: `${title} for ${client.name} (${openings} opening${openings === 1 ? '' : 's'}), requested via ${via} by ${user.name || 'a user'}. Open it in Jobs and press Activate to make it live.`,
    exceptUserId: user.id,
  }).catch(() => null);
  return { status: 201, body: { ok: true, id: created.id, reqCode: created.reqCode, status: 'DRAFT', message: `Request ${created.reqCode} sent — a Manager / Admin will review and open it.` } };
}

module.exports = { createRequirementRequest };
