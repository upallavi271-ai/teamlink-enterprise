// ---------------------------------------------------------------------------
// THE CRM FOR GENERAL SALES LEADS (founder 2026-11-06): what the CRM spec adds to the CRM of 2026-11-02 (crm/service.js), first part.
//
//   the lead pipeline   every lead stands on a stage (New, Contacted, Qualified, Proposal, Negotiation, Won, Lost: CRM settings can add, rename, reorder and
//                       colour them; Won and Lost always stay, last). A lead's status (New / Contacted / Qualified / Converted / Junk) still drives the older screens and follows.
//   website leads       POST /api/crm/leads/public with the API key (routes/crmWebsite.js): Source = Website, UTM and page address kept, a duplicate phone / email
//                       becomes a note on the lead already there, round-robin owner when switched on.
//   timed reminders     a follow-up has a type, a time and "remind before"; each is reminded ONCE, in the app and by WhatsApp / SMS when ticked. runDue() runs every minute.
//                       (The older daily "follow-ups today" notice in crm/service.js stays. Follow-ups made before this have no reminder of their own.)
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SETTINGS = require('./settings');

const WEBSITE_KEY = 'crm.website';
const TASK_TYPES = ['Call', 'Meeting', 'WhatsApp', 'Visit', 'Email', 'Other'];
const PRIORITIES = ['High', 'Medium', 'Low'];
// what came of a follow-up, picked when it is marked done (written on the timeline with the note)
const OUTCOMES = ['Spoke', 'No answer', 'Meeting held', 'Sent details', 'Not interested'];
const REMIND_BEFORE = [0, 15, 60, 1440]; // minutes

// ---- the stage of a lead ---------------------------------------------------------------------------------
// a lead from before stages stood where its status says; a stage that was removed from the settings = the first stage
function stageOf(lead, names) {
  if (lead.status === 'Converted') return 'Won';
  if (lead.status === 'Junk') return 'Lost';
  if (lead.stage && names.includes(lead.stage)) return lead.stage;
  if (lead.status === 'Contacted' && names.includes('Contacted')) return 'Contacted';
  if (lead.status === 'Qualified' && names.includes('Qualified')) return 'Qualified';
  return names[0];
}
const stageNames = (st) => st.leadStages.map((x) => x.name);

async function moveLead(user, id, { stage, lostReason } = {}) {
  const r = S.roleOf(user);
  const row = await S.getRow('lead', id);
  if (!S.canEditRow(user, r, row)) return S.fail(404, 'This lead is not there, or it is not yours.');
  const st = await SETTINGS.load();
  const names = stageNames(st);
  if (!names.includes(stage)) return S.fail(400, 'Pick a stage from the pipeline.');
  const from = stageOf(row, names);
  if (from === stage) return S.okBody({ ok: true, lead: { ...row, stage }, unchanged: true });
  if (row.status === 'Converted') return S.fail(409, 'This lead is already a deal. Work it on its deal.');
  const reason = S.clip(lostReason, 300);
  if (stage === 'Lost' && !reason) return S.fail(400, 'Please say why it was lost.');
  const i = names.indexOf(stage);
  const status = row.status === 'Junk' ? 'Junk' : (i === 0 ? 'New' : (i === 1 ? 'Contacted' : 'Qualified'));
  const lead = await S.update('CrmLead', row.id, { stage, status: stage === 'Lost' ? status : (row.status === 'Junk' ? 'Qualified' : status), lostReason: stage === 'Lost' ? reason : null, updatedAt: DB.nowIso() });
  await S.addActivity(user, { kind: 'note', leadId: row.id, subject: `Stage: ${from} → ${stage}`, note: stage === 'Lost' ? `Lost reason: ${reason}` : null }).catch(() => null);
  return S.okBody({ ok: true, lead: { ...lead, stage }, needsDeal: stage === 'Won' && !row.dealId });
}

// ---- the website form --------------------------------------------------------------------------------------
async function websiteRow() {
  const row = await prisma.appSetting.findUnique({ where: { key: WEBSITE_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return { key: typeof v.key === 'string' ? v.key : '', autoAssign: v.autoAssign === true, lastOwnerId: v.lastOwnerId || null };
}
async function websiteWrite(v) {
  const value = JSON.stringify(v);
  await prisma.appSetting.upsert({ where: { key: WEBSITE_KEY }, create: { key: WEBSITE_KEY, value }, update: { value } });
}
const newKey = () => `tlcrm_${crypto.randomBytes(24).toString('base64url')}`;
const onlyManagers = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'The website form is set up by a Sales manager or an Admin.'));

async function websiteGet(user) {
  const no = onlyManagers(user); if (no) return no;
  const v = await websiteRow();
  if (!v.key) { v.key = newKey(); await websiteWrite(v); }
  return S.okBody({ key: v.key, autoAssign: v.autoAssign });
}
async function websiteSave(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const v = await websiteRow();
  v.autoAssign = body.autoAssign === true;
  if (!v.key) v.key = newKey();
  await websiteWrite(v);
  return S.okBody({ ok: true, key: v.key, autoAssign: v.autoAssign });
}
async function websiteNewKey(user) {
  const no = onlyManagers(user); if (no) return no;
  const v = await websiteRow();
  v.key = newKey();
  await websiteWrite(v);
  await S.audit(user, 'CRM website form key changed', 'AppSetting', WEBSITE_KEY, 'A new key: the old one stopped working');
  return S.okBody({ ok: true, key: v.key });
}

function sameKey(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
// round robin over the sales team (Sales managers too only when nobody else is there)
async function nextOwner(v) {
  const all = await S.ownerOptions();
  const reps = all.filter((o) => !o.tl);
  const list = reps.length ? reps : all;
  if (!list.length) return null;
  const i = list.findIndex((o) => o.id === v.lastOwnerId);
  return list[(i + 1) % list.length];
}

/** -> { status, body } A filled honeypot ("website_url") looks like a success to the robot, and nothing is saved. */
async function capture(body = {}, headerKey = '') {
  const v = await websiteRow();
  if (!v.key || !sameKey(headerKey || body.api_key || body.apiKey, v.key)) return S.fail(401, 'The API key is not right.');
  if (S.clip(body.website_url, 200)) return S.okBody({ ok: true });
  const name = S.clip(body.name, 200);
  const company = S.clip(body.company, 200) || name;
  const phone = S.clip(body.phone, 40);
  const email = S.clip(body.email, 200);
  const message = S.clip(body.message || body.notes, 2000);
  if (!company) return S.fail(400, 'A name is needed.');
  if (!phone && !email) return S.fail(400, 'A phone number or an email is needed.');
  const c = S.cleanFields('lead', { company, contactName: name, phone, email, source: 'Website', notes: message }, { partial: false });
  if (c.error) return S.fail(400, c.error);
  const utm = {
    utmSource: S.clip(body.utm_source, 120), utmMedium: S.clip(body.utm_medium, 120), utmCampaign: S.clip(body.utm_campaign, 120), pageUrl: S.clip(body.page_url || body.pageUrl, 500),
  };
  const now = DB.nowIso();
  // the same phone or email again: a note on the lead already there
  const ph = S.phone10(phone); const em = String(email || '').toLowerCase();
  const same = (await DB.all('SELECT "id", "phone", "email", "ownerId", "ownerName" FROM "CrmLead"')).find((l) => (ph.length === 10 && S.phone10(l.phone) === ph) || (em && String(l.email || '').toLowerCase() === em));
  if (same) {
    await S.insert('CrmActivity', {
      id: S.newId('act'), kind: 'note', subject: 'Filled the website form again', note: [message, utm.pageUrl].filter(Boolean).join(' · ') || null, at: now, leadId: same.id, byName: 'Website form', createdAt: now,
    });
    return S.okBody({ ok: true, duplicate: true });
  }
  const own = v.autoAssign ? await nextOwner(v) : null;
  const saved = await S.insert('CrmLead', {
    id: S.newId('lead'), ...c.data, ...utm, source: 'Website', status: 'New', stage: (await SETTINGS.load()).leadStages[0].name, ownerId: own ? own.id : null, ownerName: own ? own.name : null, createdById: null, createdAt: now, updatedAt: now,
  });
  if (own) {
    await websiteWrite({ ...v, lastOwnerId: own.id });
    await prisma.notification.create({ data: { userId: own.id, title: `New website lead: ${saved.company}`, message: `Open: /crm/leads?open=lead:${saved.id}`, channel: 'In-App', recipient: `crm-web|${saved.id}`, status: 'Sent' } }).catch(() => {});
    await firstFollowUp(saved).catch(() => null); // the first call, two hours on
  }
  return S.okBody({ ok: true, id: saved.id });
}

// ---- follow-ups: the extra fields --------------------------------------------------------------------------
async function taskExtras(body = {}) {
  const st = await SETTINGS.load();
  const before = Number(body.remindBefore);
  return {
    type: TASK_TYPES.includes(body.type) ? body.type : 'Call',
    priority: PRIORITIES.includes(body.priority) ? body.priority : 'Medium',
    notifyApp: body.notifyApp === false ? 0 : 1,
    notifyWhatsapp: body.notifyWhatsapp === true ? 1 : 0,
    notifySms: body.notifySms === true ? 1 : 0,
    notifyLead: body.notifyLead === true ? 1 : 0,
    remindBefore: REMIND_BEFORE.includes(before) ? before : st.defaultRemindBefore,
  };
}

async function cancelTask(user, id) {
  const r = S.roleOf(user);
  const row = await S.getRow('CrmTask', id);
  if (!S.canEditRow(user, r, row)) return S.fail(404, 'This follow-up is not there, or it is not yours.');
  if (row.status !== 'Open') return S.fail(409, 'Only an open follow-up can be cancelled.');
  const task = await S.update('CrmTask', row.id, { status: 'Cancelled', updatedAt: DB.nowIso() });
  return S.okBody({ ok: true, task });
}

// the in-app reminders of the last two hours, for the toast on any page (components/crm/CrmReminderToast.jsx)
async function liveReminders(user) {
  const rows = await prisma.notification.findMany({
    where: { userId: user.id, read: false, OR: [{ recipient: { startsWith: 'crm-task|' } }, { recipient: { startsWith: 'crm-reply|' } }], createdAt: { gt: new Date(Date.now() - 2 * 3600000) } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, title: true, message: true },
  });
  return S.okBody({ reminders: rows });
}

// ---- the reminder job --------------------------------------------------------------------------------------
const dueMoment = (t) => Date.parse(`${t.dueDate}T${t.dueTime || '09:00'}:00+05:30`);

async function sendText(channel, phone, text, deps) {
  // eslint-disable-next-line global-require
  const messaging = deps.messaging || require('../utils/messaging');
  const st = await messaging.channelStatus();
  if (!(st[channel] && st[channel].configured)) return { ok: false, why: `${channel} is not connected` };
  // eslint-disable-next-line global-require
  const m = (deps.normalizeMobile || require('../utils/messagingCore').normalizeMobile)(phone);
  if (!m.ok) return { ok: false, why: 'no usable phone number' };
  const r = await messaging.send(channel, { to: m.e164, kind: 'bulk', text, vars: [text] });
  return { ok: !!r.ok, why: r.ok ? null : String(r.error || r.outcome || 'not sent') };
}

/** One pass: what is due now is sent once. -> the number reminded. */
async function runDue({ now = Date.now(), deps = {} } = {}) {
  const until = new Date(now + 2 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  const rows = await DB.all(`SELECT t.*, COALESCE(d."title", l."company", a."name") AS "recordName", l."phone" AS "leadPhone",
      CASE WHEN t."dealId" IS NOT NULL THEN 'deal' WHEN t."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind", COALESCE(t."dealId", t."leadId", t."accountId") AS "recordId"
    FROM "CrmTask" t LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE t."status" = 'Open' AND t."reminderSentAt" IS NULL AND t."notifyApp" IS NOT NULL AND t."dueDate" <= ? LIMIT 500`, until);
  let sent = 0;
  for (const t of rows) {
    const at = dueMoment(t);
    if (Number.isNaN(at) || now < at - (Number(t.remindBefore) || 0) * 60000) continue; // eslint-disable-line no-continue
    // claimed first: two passes can never both send
    // eslint-disable-next-line no-await-in-loop
    const claimed = await DB.run('UPDATE "CrmTask" SET "reminderSentAt" = ? WHERE "id" = ? AND "reminderSentAt" IS NULL', new Date(now).toISOString(), t.id);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    sent += 1;
    const when = `${t.dueDate}${t.dueTime ? ` at ${t.dueTime}` : ''}`;
    const text = `TeamLink CRM follow-up (${t.type || 'Call'}): ${t.title}${t.recordName ? ` - ${t.recordName}` : ''}, ${when}`;
    const results = [];
    const lines = [text, `Open: /crm/${t.recordKind}s?open=${t.recordKind}:${t.recordId}`];
    // the owner's number is on their employee record
    // eslint-disable-next-line no-await-in-loop
    const emp = t.ownerId && (t.notifyWhatsapp || t.notifySms) ? await prisma.employee.findFirst({ where: { userId: t.ownerId }, select: { phone: true } }).catch(() => null) : null;
    for (const [flag, channel] of [[t.notifyWhatsapp, 'WhatsApp'], [t.notifySms, 'SMS']]) {
      if (!flag) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const out = emp && emp.phone ? await sendText(channel, emp.phone, text, deps).catch((e) => ({ ok: false, why: e.message })) : { ok: false, why: 'no phone number on the employee record' };
      results.push(`${channel} to owner: ${out.ok ? 'sent' : out.why}`);
      if (!out.ok && channel === 'WhatsApp' && t.leadPhone) lines.push(`WhatsApp them: https://wa.me/${S.phone10(t.leadPhone).length === 10 ? `91${S.phone10(t.leadPhone)}` : ''}`);
      if (t.notifyLead && t.leadPhone) {
        // eslint-disable-next-line no-await-in-loop
        const toLead = await sendText(channel, t.leadPhone, `Reminder from TeamLink: ${t.title}, ${when}`, deps).catch((e) => ({ ok: false, why: e.message }));
        results.push(`${channel} to the lead: ${toLead.ok ? 'sent' : toLead.why}`);
        if (toLead.ok && t.leadId) {
          const stamp = DB.nowIso();
          // eslint-disable-next-line no-await-in-loop
          await S.insert('CrmActivity', { id: S.newId('act'), kind: channel === 'WhatsApp' ? 'whatsapp' : 'note', subject: `${channel} reminder sent`, note: t.title, at: stamp, leadId: t.leadId, byName: 'Reminder', createdAt: stamp }).catch(() => null);
        }
      }
    }
    if (t.notifyApp && t.ownerId) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: t.ownerId, title: `⏰ CRM follow-up: ${t.recordName || t.title}`, message: lines.join('\n'), channel: 'In-App', recipient: `crm-task|${t.id}`, status: 'Sent' } }).catch(() => {});
    }
    // eslint-disable-next-line no-await-in-loop
    if (results.length) await DB.run('UPDATE "CrmTask" SET "reminderNote" = ? WHERE "id" = ?', results.join('; ').slice(0, 500), t.id);
  }
  return sent;
}

// ---- the first call of a new lead (founder 2026-11-14: "lead create ayyaka first follow-up task auto ravali, 2 hrs lo call cheyyi") ------------
// A lead typed in by hand or arriving from the website form with an owner gets "First call" as a High follow-up two hours from now (moved to
// 10:00 when that falls outside 9 am - 7 pm India time). An Excel import and a lead nobody owns yet get none. CRM settings > First call can switch it off.
async function firstFollowUp(lead, { now = Date.now() } = {}) {
  if (!lead || !lead.id || !lead.ownerId) return null;
  const st = await SETTINGS.load();
  if (st.autoFirstFollowUp === false) return null;
  const ist = new Date(now + 5.5 * 3600000 + 2 * 3600000); // two hours on, in India time
  let dueDate = ist.toISOString().slice(0, 10);
  let dueTime = ist.toISOString().slice(11, 16);
  const h = ist.getUTCHours();
  if (h >= 19) { dueDate = new Date(Date.parse(`${dueDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); dueTime = '10:00'; } else if (h < 9) dueTime = '10:00';
  const stamp = DB.nowIso();
  return S.insert('CrmTask', {
    id: S.newId('task'), title: `First call: ${lead.company}`, dueDate, dueTime, ...(await taskExtras({ type: 'Call', priority: 'High' })),
    status: 'Open', leadId: lead.id, accountId: null, dealId: null, ownerId: lead.ownerId, ownerName: lead.ownerName || null, createdById: lead.createdById || null, createdAt: stamp, updatedAt: stamp,
  });
}

// ---- overdue -> the managers (founder 2026-11-14: "overdue ayithe red mark, manager ki alert") ----------------------------------------------
// A follow-up that is a day late (the red "Overdue" tab) is told to the Sales managers ONCE, one bell notice per salesperson listing what is late
// (so ten late calls are one notice, not ten). Admins hear it only when no Sales manager is on the team. Switched off by CRM settings > Overdue alert.
async function managersToTell() {
  const st = await SETTINGS.load();
  const managers = (st.salesTeam || []).filter((m) => m.role === 'manager' && m.userId).map((m) => m.userId);
  if (managers.length) return [...new Set(managers)];
  const admins = await prisma.user.findMany({ where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, status: 'Active' }, select: { id: true }, take: 5 }).catch(() => []);
  return admins.map((u) => u.id);
}
/** One pass: the follow-ups that became overdue since the last pass are told to the managers once. -> the number of follow-ups told. */
async function escalateOverdue({ now = Date.now(), notify } = {}) {
  const st = await SETTINGS.load();
  if (st.overdueAlertManagers === false) return 0;
  const today = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
  const rows = await DB.all(`SELECT t.*, COALESCE(d."title", l."company", a."name") AS "recordName",
      CASE WHEN t."dealId" IS NOT NULL THEN 'deal' WHEN t."leadId" IS NOT NULL THEN 'lead' ELSE 'account' END AS "recordKind", COALESCE(t."dealId", t."leadId", t."accountId") AS "recordId"
    FROM "CrmTask" t LEFT JOIN "CrmDeal" d ON d."id" = t."dealId" LEFT JOIN "CrmLead" l ON l."id" = t."leadId" LEFT JOIN "CrmAccount" a ON a."id" = t."accountId"
    WHERE t."status" = 'Open' AND t."dueDate" < ? AND t."escalatedAt" IS NULL AND t."ownerId" IS NOT NULL ORDER BY t."dueDate" ASC LIMIT 500`, today);
  if (!rows.length) return 0;
  const managers = await managersToTell();
  if (!managers.length) return 0; // nobody to tell: they stay un-alerted, and are told when a manager is added
  const send = notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
  const byOwner = new Map();
  for (const t of rows) {
    // claimed first: two passes can never both tell
    // eslint-disable-next-line no-await-in-loop
    const claimed = await DB.run('UPDATE "CrmTask" SET "escalatedAt" = ? WHERE "id" = ? AND "escalatedAt" IS NULL', new Date(now).toISOString(), t.id);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    byOwner.set(t.ownerId, [...(byOwner.get(t.ownerId) || []), t]);
  }
  let told = 0;
  for (const [ownerId, list] of byOwner) {
    const to = managers.filter((id) => id !== ownerId);
    if (!to.length) continue; // eslint-disable-line no-continue
    const days = (t) => Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.dueDate}T00:00:00Z`)) / 86400000));
    const lines = list.slice(0, 6).map((t) => `- ${t.priority === 'High' ? '[High] ' : ''}${t.type || 'Call'}: ${t.title}${t.recordName ? ` (${t.recordName})` : ''}, ${days(t)} day${days(t) === 1 ? '' : 's'} late`);
    if (list.length > 6) lines.push(`- and ${list.length - 6} more`);
    const who = list[0].ownerName || 'A salesperson';
    // eslint-disable-next-line no-await-in-loop
    await send(to, { title: `⚠️ Overdue CRM follow-ups: ${who} has ${list.length}`, message: `${lines.join('\n')}\nOpen: /crm/followups` }).catch(() => null);
    told += list.length;
  }
  return told;
}

module.exports = {
  PRIORITIES, OUTCOMES, firstFollowUp, escalateOverdue, TASK_TYPES, REMIND_BEFORE, stageOf, stageNames, moveLead, capture, websiteGet, websiteSave, websiteNewKey, taskExtras, cancelTask, liveReminders, runDue,
};
