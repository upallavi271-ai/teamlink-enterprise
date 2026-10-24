// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO ADD A JOB" (user, 2026-10-13: creating a job is the BDE team's and above).
//
// A TL / STL / Recruiter cannot create a job (utils/jobCreateRule.js). When they need a new one they press one plain
// button on the Jobs page, type the job title (and, if they like, the client and a short note), and that
//   * sends a bell (and a mail, when company mail is connected) to the client manager (BDE): the client's own BDE when a
//     client is named, else the BDE of the client's / the asker's desk, else the BDE TL,
//   * carries ONLY what was typed: job title, client, note. Never a candidate, a phone, an email or a salary,
//   * can be sent ONCE PER REQUEST: the same person asking for the same job title for the same client again today is told
//     "Already asked today" instead of sending a second bell,
//   * gives the BDE an "Open" link that opens the Request-a-job form with the title and client already filled in.
// Nothing new is stored in the schema: the request is an audit row (action 'Job add asked').
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ACTION = 'Requirement add asked';
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const istDayStart = (d = new Date()) => new Date(`${istDay(d)}T00:00:00+05:30`);

// body: { title, clientId?, notes? }  -> { status, body }
async function ask(user, body, { clientVisible } = {}) {
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  const b = body || {};
  const title = clean(b.title, 160);
  if (title.length < 2) return { status: 400, body: { error: 'Type the requirement you need, for example "Staff Nurse".', field: 'title' } };
  const notes = clean(b.notes, 500);
  let client = null;
  if (b.clientId) {
    client = await prisma.client.findUnique({ where: { id: String(b.clientId) }, select: { id: true, name: true, ownerDepartment: true, bdeOwner: true, secondaryBde: true, clientType: true } }).catch(() => null);
    // the client list this login may pick from (names only), like the Add job form's
    if (!client || (clientVisible && !(await clientVisible(client.id)))) return { status: 403, body: { error: 'Pick a client from your list, or leave the client empty.', field: 'clientId' } };
  }
  const key = `${user.id}|${client ? client.id : '-'}|${title.toLowerCase()}`;
  const prior = await prisma.auditLog.findFirst({ where: { action: ACTION, fromValue: key, createdAt: { gte: istDayStart() } }, select: { id: true } });
  if (prior) return { status: 200, body: { ok: true, already: true, message: 'You already asked for this requirement today. The client manager has it.' } };

  const IR = require('./interviewRequest'); // eslint-disable-line global-require
  const dept = (client && client.ownerDepartment) || clean(b.department, 80) || user.atsDepartment || user.department || null;
  const to = await IR.recipientsFor({ clientId: client ? client.id : null, client, department: dept, internal: false });
  const people = to.ids.length ? await prisma.user.findMany({ where: { id: { in: to.ids }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
  const who = people.filter((p) => p.id !== user.id);
  const open = `/requirements?new=1${client ? `&clientId=${encodeURIComponent(client.id)}` : ''}&title=${encodeURIComponent(title)}`;
  const nTitle = `Requirement to add: ${title}`;
  const message = `${user.name} asks you to add a requirement: ${title}${client ? ` for ${client.name}` : ''}.${notes ? ` Note: ${notes}` : ''}\nOpen: ${open}`;
  for (const p of who) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: p.id, title: nTitle, message, channel: 'In-App', recipient: `job-ask|${key}|${p.id}`.slice(0, 250), status: 'Sent' } });
  }
  // mail, only when company mail is connected (the sandbox mailer is a fake transport)
  const mailed = [];
  try {
    const ch = await require('./messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
    if (ch.Email && ch.Email.configured) {
      for (const p of who) {
        if (!p.email) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const m = await require('./interviewNotices').mailTo(p.email, nTitle, `Hello ${p.name},\n\n${user.name} asks you to add a requirement: ${title}${client ? ` for ${client.name}` : ''}.${notes ? `\nNote: ${notes}` : ''}\n\nOpen TeamLink -> Requirements -> Request requirement.\n\n- TeamLink`); // eslint-disable-line global-require
        if (m && m.ok) mailed.push(p.id);
      }
    }
  } catch { /* the bell is the sure part */ }
  await logAudit({
    userId: user.id, actorName: user.name || null, action: ACTION, entity: client ? 'Client' : 'Requirement', entityId: client ? client.id : null,
    fromValue: key, toValue: title, reason: `Asked ${who.map((p) => p.name).join(', ') || 'nobody'} (${to.via})${notes ? ` - ${notes}` : ''}`.slice(0, 1000),
  });
  return {
    status: 201,
    body: {
      ok: true, told: who.map((p) => p.name), via: to.via, mailed: mailed.length,
      message: who.length ? `Asked ${who.map((p) => p.name).join(', ')} to add this requirement.` : 'Saved. No client manager is named for this yet, so nobody was told.',
    },
  };
}

// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO EDIT OR CLOSE THIS JOB" (2026-10-13): the same bell for an EXISTING job a TL / STL / Recruiter
// cannot change. what: 'edit' | 'close'. Once per person, job and kind per day. Only the job and the typed note are sent.
// ---------------------------------------------------------------------------
const CHANGE_ACTION = 'Requirement change asked';
async function askChange(user, requirement, body) {
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  const b = body || {};
  const what = String(b.what || '') === 'close' ? 'close' : 'edit';
  const notes = clean(b.notes, 500);
  if (what === 'edit' && notes.length < 3) return { status: 400, body: { error: 'Say what should change, for example "openings 2 to 5".', field: 'notes' } };
  const key = `${user.id}|${requirement.id}|${what}`;
  const prior = await prisma.auditLog.findFirst({ where: { action: CHANGE_ACTION, fromValue: key, createdAt: { gte: istDayStart() } }, select: { id: true } });
  if (prior) return { status: 200, body: { ok: true, already: true, message: 'You already asked this today. The client manager has it.' } };
  const client = requirement.clientId ? await prisma.client.findUnique({ where: { id: requirement.clientId }, select: { id: true, name: true, ownerDepartment: true, bdeOwner: true, secondaryBde: true } }).catch(() => null) : null;
  const IR = require('./interviewRequest'); // eslint-disable-line global-require
  const to = await IR.recipientsFor({ ...requirement, client });
  const people = to.ids.length ? await prisma.user.findMany({ where: { id: { in: to.ids }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
  const who = people.filter((p) => p.id !== user.id);
  const job = `${requirement.reqCode ? `${requirement.reqCode} - ` : ''}${requirement.title}`;
  const verb = what === 'close' ? 'close' : 'change';
  const nTitle = `Requirement to ${verb}: ${requirement.title}`;
  const message = `${user.name} asks you to ${verb} the requirement ${job}${client ? ` (${client.name})` : ''}.${notes ? ` Note: ${notes}` : ''}
Open: /requirements/${requirement.id}`;
  for (const p of who) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: p.id, title: nTitle, message, channel: 'In-App', recipient: `job-change|${key}|${p.id}`.slice(0, 250), status: 'Sent' } });
  }
  const mailed = [];
  try {
    const ch = await require('./messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
    if (ch.Email && ch.Email.configured) {
      for (const p of who) {
        if (!p.email) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const m = await require('./interviewNotices').mailTo(p.email, nTitle, `Hello ${p.name},

${user.name} asks you to ${verb} the requirement ${job}.${notes ? `
Note: ${notes}` : ''}

Open TeamLink -> Requirements.

- TeamLink`); // eslint-disable-line global-require
        if (m && m.ok) mailed.push(p.id);
      }
    }
  } catch { /* the bell is the sure part */ }
  await logAudit({ userId: user.id, actorName: user.name || null, action: CHANGE_ACTION, entity: 'Requirement', entityId: requirement.id, fromValue: key, toValue: what, reason: `Asked ${who.map((p) => p.name).join(', ') || 'nobody'} (${to.via})${notes ? ` - ${notes}` : ''}`.slice(0, 1000) });
  return { status: 201, body: { ok: true, told: who.map((p) => p.name), via: to.via, mailed: mailed.length, message: who.length ? `Asked ${who.map((p) => p.name).join(', ')} to ${verb} this requirement.` : 'Saved. No client manager is named for this requirement yet, so nobody was told.' } };
}

module.exports = { ACTION, CHANGE_ACTION, ask, askChange };
