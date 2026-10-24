// ---------------------------------------------------------------------------
// OMNI-CHANNEL CONNECTIONS (founder note (f), 2026-10-17): in plain words, how Omni-Channel is joined to HRMS, ATS, Accounts and the Job Portal.
// status(): one row per link { id, name, state: green | yellow | red, summary, facts: [..], notBuilt: [..], canSync }. READ ONLY: it only counts rows
// and reads settings. It never sends a message and never changes data ("Test connection" = this same read, run again).
// syncHrms(): the one cheap and safe link we build now: staff (Employees with a phone or email) -> INTERNAL contacts. Consent is NOT assumed:
// the new contacts start "no permission recorded", so nothing can be sent to them until consent is recorded (and Test mode stays on).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const K = require('./contacts');
const { logAudit } = require('../utils/audit');

const count = async (fn) => { try { return Number(await fn()) || 0; } catch { return null; } };
const row = (id, name, state, summary, facts, notBuilt = [], extra = {}) => ({ id, name, state, summary, facts, notBuilt, ...extra });

async function hrms() {
  const emps = await count(() => prisma.employee.count({ where: { OR: [{ phone: { not: null } }, { email: { not: null } }] } }));
  const internal = (await S.ready()) ? await count(async () => (await S.q('SELECT COUNT(*) n FROM "OutreachContact" WHERE contactType = \'internal\' AND status = \'active\''))[0].n).then((n) => (typeof n === 'number' ? S.num(n) : n)) : null;
  let rules = null;
  try { rules = (await require('./scheduled').loadRules()).length; } catch { rules = null; } // eslint-disable-line global-require
  const state = emps === null || internal === null ? 'red' : (internal > 0 && rules > 0 ? 'green' : 'yellow');
  const facts = [
    `${emps == null ? 'Unknown' : emps} staff have a phone or email on their employee card.`,
    `${internal == null ? 'Unknown' : internal} of them are already internal contacts in Omni-Channel.`,
    `${rules == null ? 'Unknown' : rules} scheduled staff messages (birthdays, reminders, notices) are set up.`,
  ];
  return row('hrms', 'HRMS (staff, birthdays, notices)', state,
    state === 'green' ? 'Connected: staff are internal contacts and scheduled staff messages exist.' : 'Partly connected: staff are not all in Omni-Channel yet.', facts,
    ['Leave-approved / attendance notices as automatic internal messages: not built (they go through the HRMS notification bell today).'], { canSync: true, syncWord: 'Add staff as internal contacts' });
}
async function ats() {
  const [jobs, cands, camps, applied] = await Promise.all([
    count(() => prisma.requirement.count({ where: { status: 'OPEN' } })),
    count(() => prisma.candidate.count()),
    (await S.campaignsReady()) ? count(async () => (await S.q('SELECT COUNT(*) n FROM "OutreachCampaign" WHERE type = \'job_promotion\' AND status <> \'draft\''))[0].n) : Promise.resolve(null),
    (await S.campaignsReady()) ? count(async () => (await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE type = \'applied\''))[0].n) : Promise.resolve(null),
  ]);
  const state = jobs === null || cands === null ? 'red' : (camps > 0 ? 'green' : 'yellow');
  return row('ats', 'ATS (requirements, candidates, applications)', state,
    state === 'green' ? 'Connected: requirement campaigns are linked to open requirements, and replies land in the ATS inbox.' : 'Ready, but no requirement campaign has been sent yet.',
    [`${jobs == null ? 'Unknown' : jobs} open requirements can be promoted.`, `${cands == null ? 'Unknown' : cands} candidates in the ATS (their replies show in Responses).`, `${camps == null ? 'Unknown' : camps} job campaigns started; ${applied == null ? 'Unknown' : applied} applications came from them.`],
    ['Candidate permission is never assumed: a candidate who applied has not agreed to job promotions until permission is recorded (Admin / Team Lead can copy candidates into Contacts; every way of contact starts "Not asked").']);
}
async function accounts() {
  const open = await count(() => prisma.invoice.count({ where: { status: { in: ['Pending', 'Partially Paid', 'Overdue'] } } }));
  let camps = null; let replies = null;
  try {
    await require('./omni/schema').ensure(); // eslint-disable-line global-require
    camps = S.num((await S.q("SELECT COUNT(*) n FROM \"OmniAppCampaign\" WHERE app = 'Accounts'"))[0].n);
    replies = S.num((await S.q("SELECT COUNT(*) n FROM \"OmniReplyLink\" WHERE apps LIKE '%Accounts%'"))[0].n);
  } catch { camps = null; }
  const state = camps === null ? 'red' : (camps > 0 ? 'green' : 'yellow');
  return row('accounts', 'Accounts (invoice and payment reminders)', state,
    state === 'green' ? "Connected: payment reminders are Omni-Channel campaigns, and the client contact's replies show in Accounts." : 'Connected, but no payment reminder campaign has been made from Accounts yet.',
    [`${open == null ? 'Unknown' : open} invoices are waiting for payment (Accounts shows them).`, `${camps == null ? 'Unknown' : camps} reminder campaigns made from Accounts.`, `${replies == null ? 'Unknown' : replies} replies matched to Accounts records.`],
    ['A reminder for every overdue invoice by itself: not built (a person picks the invoices and sends or schedules the campaign).']);
}
async function portal() {
  const published = await count(() => prisma.requirement.count({ where: { portalPublished: true } }));
  const applied = (await S.campaignsReady()) ? await count(async () => (await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE type = \'applied\' AND source = \'portal\''))[0].n) : null;
  const base = process.env.APP_BASE_URL || '';
  const state = published === null ? 'red' : (published > 0 && base ? 'green' : 'yellow');
  return row('portal', 'Job Portal (applications and job events)', state,
    state === 'green' ? 'Connected: each message carries a tracked apply link to the portal.' : 'Partly connected: ' + (base ? 'no job is published on the portal yet.' : 'the public site address (APP_BASE_URL) is not set, so apply links cannot work.'),
    [`${published == null ? 'Unknown' : published} jobs are published on the portal.`, `${applied == null ? 'Unknown' : applied} applications were recorded from portal events.`],
    ['Phase 4b portal events (opened job, started AI interview, qualified) coming back into campaign reports: not built. Plan: the portal posts a signed event to /api/public/outreach and outreach/events.js records it (the table already has the event types).']);
}
async function channels() {
  let st = null;
  try { st = await require('../utils/messaging').channelStatus(); } catch { st = null; } // eslint-disable-line global-require
  if (!st) return row('channels', 'Email, WhatsApp and SMS', 'red', 'Could not read the channel settings.', []);
  const on = ['Email', 'SMS', 'WhatsApp'].filter((c) => st[c] && st[c].configured);
  const settings = (await S.ready()) ? await S.settings() : { emailTestMode: true };
  return row('channels', 'Email, WhatsApp and SMS', on.length === 3 ? 'green' : (on.length ? 'yellow' : 'red'),
    on.length ? `Connected: ${on.join(', ')}.` : 'No channel is connected yet.',
    ['Email: ' + (st.Email.configured ? 'connected' : 'not connected'), 'WhatsApp: ' + (st.WhatsApp.configured ? 'connected' : 'not connected'), 'SMS: ' + (st.SMS.configured ? 'connected' : 'not connected'), settings.emailTestMode ? 'Test mode is ON: campaign emails are only rehearsed, nothing is sent to real people.' : 'Test mode is OFF: campaign emails are real.'], []);
}
async function status() {
  const rows = [];
  for (const f of [hrms, ats, accounts, portal, channels]) rows.push(await f()); // eslint-disable-line no-await-in-loop
  return { links: rows, checkedAt: new Date().toISOString(), note: 'This page only reads. Pressing "Test connection" counts rows and reads settings; it never sends a message.' };
}
async function test(id) {
  const all = await status();
  return all.links.find((l) => l.id === id) || null;
}

// staff -> internal contacts (Admin). Returns counts.
async function syncHrms(user) {
  if (!(await S.ready())) return { error: 'Omni-Channel is being set up.', status: 503 };
  const emps = await prisma.employee.findMany({ where: { OR: [{ phone: { not: null } }, { email: { not: null } }] }, select: { name: true, phone: true, email: true, department: true, employeeCode: true }, take: 3000 });
  let added = 0; let existed = 0; let skipped = 0;
  for (const e of emps) {
    const phone = K.phoneOf(e.phone); const email = K.emailOf(e.email);
    if (!phone.ok && !email.ok) { skipped += 1; continue; } // eslint-disable-line no-continue
    const dups = await K.findByKeys(phone.ok ? phone.key : null, email.ok ? email.key : null); // eslint-disable-line no-await-in-loop
    if (dups.length) { existed += 1; continue; } // eslint-disable-line no-continue
    try {
      await K.insert(user, { type: 'internal', name: e.name, phone: phone.ok ? phone : null, email: email.ok ? email : null, company: 'Staff', city: null, source: `HRMS employee ${e.employeeCode}`, department: e.department || null, industries: [] }, { declared: false }); // eslint-disable-line no-await-in-loop
      added += 1;
    } catch { skipped += 1; }
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel staff contacts synced from HRMS', entity: 'OutreachContact', entityId: 'hrms', toValue: `${added} added, ${existed} already there` });
  return { added, existed, skipped, note: 'Added with no permission recorded: nothing can be sent to them until consent is recorded. Test mode stays on.' };
}

module.exports = { status, test, syncHrms };
