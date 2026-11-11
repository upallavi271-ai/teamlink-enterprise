// ---------------------------------------------------------------------------
// THE CRM RUNS BY ITSELF (founder 2026-11-06: "crm lo, manual ga em jaragakudadhu, mottham antha automatic ga avvali, mails ayina, calls ayina, sms ayina, leads tho meeting ayina,
// customers tho meeting ayina").
//
// A new lead gets a sequence without anybody pressing a button: a mail and an SMS at once, an AI call, then WhatsApp, a mail and an SMS over the week (CRM settings change the words,
// the timing, and each step on / off). What the AI call hears moves the lead: interested -> Qualified and a meeting is booked (calendar invite to the lead and the owner, reminders
// through crm/sales.js); not interested -> Lost; do not call -> opted out of everything; call back -> a follow-up for the owner. A customer gets a check-in meeting every N days.
// Everything is written on the record's timeline as "Autopilot".
//
// THE LIMITS, none of them optional:
//   * OFF until a Sales manager or Admin turns it on, and then ONLY leads that arrive after that moment: old leads and old customer lists are never messaged.
//   * nothing goes in quiet hours (Message templates > Limits): it waits for the morning.
//   * an opt-out (CrmOptOut: the unsubscribe link, or "do not call") stops the person at once, on every channel.
//   * a lead stops being worked once it is past Contacted, Won, Lost, Junk or Converted, when somebody presses Stop on it, or the moment they REPLY by SMS, WhatsApp or mail: a person takes it
//     from there (onReply; an out-of-office is not a reply, "stop" is an opt-out).
//   * at most 20 sends a minute. Sample records ("Sample · ...") are never contacted.
// Each step is claimed before it is sent, so two passes can never send it twice. tick() runs every minute (routes/crm.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./schema');
const S = require('./service');
const SALES = require('./sales');
const SETTINGS = require('./settings');

const KEY = 'crm.autopilot';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_PER_TICK = 20;
const CHANNELS = ['email', 'sms', 'whatsapp', 'call'];
const BY = 'Autopilot';
const CALL_SCRIPT = [
  'Opening: Hello {name}, this is an AI assistant calling from TeamLink Consultants. You showed interest in our services.',
  'Ask: Do you have a minute to talk?',
  'Interest: Would you like to meet our team to discuss what you need?',
  'Closing: Thank you. Our team will be in touch. Have a good day.',
  'Decline: No problem at all. Thank you for your time. Have a good day.',
].join('\n');
const DEFAULTS = {
  on: false,
  armedAt: null,
  steps: [
    { id: 'hello-mail', channel: 'email', afterHours: 0, on: true, subject: 'Thank you for reaching TeamLink, {name}', body: 'Hello {name},\n\nThank you for your interest in TeamLink. {owner} from our team will help you, and we will call you shortly.\n\nRegards,\nTeamLink' },
    { id: 'hello-sms', channel: 'sms', afterHours: 0, on: true, body: 'Hello {name}, thank you for your interest in TeamLink. We will call you shortly.' },
    { id: 'ai-call', channel: 'call', afterHours: 2, on: true },
    { id: 'day1-whatsapp', channel: 'whatsapp', afterHours: 24, on: true, body: 'Hello {name}, this is TeamLink. We tried to reach you. When would be a good time to talk?' },
    { id: 'day3-mail', channel: 'email', afterHours: 72, on: true, subject: 'Shall we talk, {name}?', body: 'Hello {name},\n\nWe would like to understand what you need and how we can help. Just reply to this mail with a time that suits you.\n\nRegards,\nTeamLink' },
    { id: 'day7-sms', channel: 'sms', afterHours: 168, on: true, body: 'Hello {name}, this is our last reminder from TeamLink. Reply any time if you would like to talk.' },
  ],
  callScript: CALL_SCRIPT,
  meeting: { on: true, minutes: 30, time: '11:00', link: '', customerEveryDays: 30 },
};

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
function clean(raw = {}) {
  const given = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = DEFAULTS.steps.map((d) => {
    const s = given.find((x) => x && x.id === d.id) || {};
    const h = Number(s.afterHours);
    return {
      ...d, on: s.on === undefined ? d.on : s.on === true, afterHours: Number.isFinite(h) && h >= 0 && h <= 720 ? h : d.afterHours,
      ...(d.subject !== undefined ? { subject: clip(s.subject, 200).trim() || d.subject } : {}), ...(d.body !== undefined ? { body: clip(s.body, 1500).trim() || d.body } : {}),
    };
  });
  const m = raw.meeting && typeof raw.meeting === 'object' ? raw.meeting : {};
  const every = Number(m.customerEveryDays);
  return {
    on: raw.on === true, armedAt: typeof raw.armedAt === 'string' ? raw.armedAt : null, steps, callScript: clip(raw.callScript, 4000).trim() || CALL_SCRIPT,
    meeting: {
      on: m.on === undefined ? true : m.on === true, minutes: [15, 30, 45, 60].includes(Number(m.minutes)) ? Number(m.minutes) : 30, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(m.time)) ? m.time : '11:00',
      link: /^https?:\/\//i.test(String(m.link || '')) ? clip(m.link, 400).trim() : '', customerEveryDays: Number.isFinite(every) && every >= 0 && every <= 365 ? every : 30,
    },
  };
}
async function load() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return clean(v);
}
async function write(v) {
  const value = JSON.stringify(v);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
const onlyManagers = (user) => (S.mayAssign(S.roleOf(user)) ? null : S.fail(403, 'The automatic follow-through is set up by a Sales manager or an Admin.'));

async function get(user) {
  const no = onlyManagers(user); if (no) return no;
  const counts = await DB.all('SELECT "status", COUNT(*) AS n FROM "CrmAutoStep" GROUP BY "status"');
  return S.okBody({ settings: await load(), counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
}
async function save(user, body = {}) {
  const no = onlyManagers(user); if (no) return no;
  const cur = await load();
  const next = clean({ ...cur, ...body, armedAt: cur.armedAt });
  // the moment it is turned on is the line: only leads after it are contacted
  if (next.on && !cur.on) next.armedAt = DB.nowIso();
  await write(next);
  if (next.on !== cur.on) await S.audit(user, next.on ? 'CRM autopilot turned on' : 'CRM autopilot turned off', 'AppSetting', KEY, next.on ? `From ${next.armedAt}` : 'Off');
  return S.okBody({ ok: true, settings: next });
}
async function pauseLead(user, id, paused) {
  const r = S.roleOf(user);
  const row = await S.getRow('lead', id);
  if (!S.canEditRow(user, r, row)) return S.fail(404, 'This lead is not there, or it is not yours.');
  await S.update('CrmLead', row.id, { autoPaused: paused ? 1 : 0, updatedAt: DB.nowIso() });
  // started again after they replied: the steps still ahead wake up, never the ones whose day has passed, never after they asked us to stop
  if (!paused) await DB.run('UPDATE "CrmAutoStep" SET "status" = \'waiting\', "result" = NULL WHERE "recordId" = ? AND "status" = \'stopped\' AND "result" LIKE \'they replied%\' AND "dueAt" > ?', row.id, DB.nowIso());
  await note({ leadId: row.id }, paused ? `Automatic follow-through stopped by ${user.name || 'a person'}` : `Automatic follow-through started again by ${user.name || 'a person'}`);
  return S.okBody({ ok: true, autoPaused: !!paused });
}

// ---- small pieces --------------------------------------------------------------------------------------------
const fillIn = (t, x) => String(t || '').replace(/\{name\}/g, x.contactName || x.company || 'there').replace(/\{company\}/g, x.company || '').replace(/\{owner\}/g, x.ownerName || 'our team');
async function note(link, subject, text, kind = 'note') {
  const now = DB.nowIso();
  await S.insert('CrmActivity', { id: S.newId('act'), kind, subject, note: text || null, at: now, leadId: link.leadId || null, accountId: link.accountId || null, byName: BY, createdAt: now }).catch(() => null);
}
async function quietNow(now) {
  // eslint-disable-next-line global-require
  const R = require('../utils/omniRules');
  return R.inQuiet(await R.settings(), new Date(now));
}
const realMail = (deps) => deps.sendMail || ((m) => require('../utils/mailer').sendMail({ useEmployeeFrom: false, fromName: 'TeamLink', ...m })); // eslint-disable-line global-require
async function sendSms(phone, text, deps) {
  if (deps.sendSms) return deps.sendSms(phone, text);
  const messaging = require('../utils/messaging'); // eslint-disable-line global-require
  const st = await messaging.channelStatus();
  if (!(st.SMS && st.SMS.configured)) return { ok: false, error: 'SMS is not connected' };
  const m = require('../utils/messagingCore').normalizeMobile(phone); // eslint-disable-line global-require
  if (!m.ok) return { ok: false, error: 'the phone number is not usable' };
  return messaging.send('SMS', { to: m.e164, kind: 'bulk', text, vars: [text] });
}
async function sendWa(x, text, deps) {
  if (deps.sendWa) return deps.sendWa(x.phone, text);
  // eslint-disable-next-line global-require
  return require('../channels/send').sendWhatsApp({ to: x.phone, text, kind: 'bulk', meta: { audience: 'crm', personName: x.contactName || x.company, purpose: 'CRM autopilot' } });
}
// ---- booking a meeting ------------------------------------------------------------------------------------------
const ymdOf = (t) => new Date(t + 5.5 * HOUR).toISOString().slice(0, 10);
// the next working day (not Sunday) at the set time, an hour later when the owner already has something then
async function nextSlot(ownerId, st, now) {
  let t = now + DAY;
  while (new Date(t + 5.5 * HOUR).getUTCDay() === 0) t += DAY;
  const day = ymdOf(t);
  const taken = ownerId ? (await DB.all('SELECT "dueTime" FROM "CrmTask" WHERE "ownerId" = ? AND "dueDate" = ? AND "status" = \'Open\'', ownerId, day)).map((x) => x.dueTime) : [];
  let [h, m] = st.meeting.time.split(':').map(Number);
  let time = st.meeting.time;
  for (let i = 0; i < 6 && taken.includes(time); i += 1) { h += 1; time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; }
  m = 0;
  return { day, time };
}
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function calendarFile({ id, title, start, minutes, link, to }) {
  return [
    'BEGIN:VCALENDAR', 'PRODID:-//TeamLink//CRM//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:crm-${id}@teamlink`, `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(start + minutes * 60000)}`, `SUMMARY:${icsEsc(title)}`, ...(link ? [`LOCATION:${icsEsc(link)}`, `DESCRIPTION:${icsEsc(`Join: ${link}`)}`] : []),
    ...to.map((a) => `ATTENDEE;RSVP=TRUE:mailto:${a}`), 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
// the CRM's own meeting link: Automatic settings, else CRM settings (never the interview settings of ATS any more)
async function meetingLink(st) {
  if (st.meeting.link) return st.meeting.link;
  const crm = await require('./settings').load().catch(() => null); // eslint-disable-line global-require
  return (crm && crm.meetingLink) || '';
}
/** One meeting: a Meeting follow-up with its reminders, and an invite to the person and the owner. -> the task */
async function bookMeeting({ leadId, accountId, name, email, ownerId, ownerName, title }, st, now, deps) {
  const slot = await nextSlot(ownerId, st, now);
  const stamp = DB.nowIso();
  const start = Date.parse(`${slot.day}T${slot.time}:00+05:30`);
  const link = await meetingLink(st);
  const task = await S.insert('CrmTask', {
    id: S.newId('task'), title, dueDate: slot.day, dueTime: slot.time, status: 'Open', type: 'Meeting', notifyApp: 1, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 60,
    leadId: leadId || null, accountId: accountId || null, ownerId: ownerId || null, ownerName: ownerName || null, createdById: null, createdAt: stamp, updatedAt: stamp,
  });
  const owner = ownerId ? await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true } }).catch(() => null) : null;
  const to = [email, owner && owner.email].filter(Boolean);
  let mailed = 'no email on record';
  if (to.length) {
    const when = new Date(start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    const text = [`Hello ${name || ''},`, '', `We have set a time to talk: ${when}.`, ...(link ? ['', `Join here: ${link}`] : ['', 'We will call you at this time.']), '', 'If this time does not suit you, just reply to this mail and we will change it.', '', 'Regards,', ownerName || 'TeamLink'].join('\n');
    const out = await realMail(deps)({ to: to.join(', '), subject: title, text, attachments: [{ filename: 'meeting.ics', content: calendarFile({ id: task.id, title, start, minutes: st.meeting.minutes, link, to }), contentType: 'text/calendar; method=REQUEST' }] }).catch((e) => ({ ok: false, error: e.message }));
    mailed = out && out.ok ? `invite sent to ${to.join(', ')}` : `invite not sent: ${(out && out.error) || 'mail failed'}`;
  }
  await note({ leadId, accountId }, `Meeting booked: ${slot.day} ${slot.time}`, mailed, 'meeting');
  return task;
}

// ---- one lead ------------------------------------------------------------------------------------------------------
async function stopReason(lead, names, deps) {
  if (!lead) return 'the lead is gone';
  if (lead.autoPaused) return 'stopped by a person';
  if (['Converted', 'Junk'].includes(lead.status)) return `the lead is ${lead.status}`;
  const stage = SALES.stageOf(lead, names);
  if (['Won', 'Lost'].includes(stage)) return `the lead is ${stage}`;
  if (names.indexOf(stage) > 1) return `a person has it: ${stage}`;
  return null;
}
async function moveLead(lead, stage, why) {
  const names = SALES.stageNames(await SETTINGS.load());
  const to = names.includes(stage) ? stage : names[Math.min(2, names.length - 1)];
  const from = SALES.stageOf(lead, names);
  if (from === to) return;
  await S.update('CrmLead', lead.id, { stage: to, status: to === 'Contacted' ? 'Contacted' : (['Won', 'Lost'].includes(to) ? lead.status : 'Qualified'), lostReason: to === 'Lost' ? why : null, updatedAt: DB.nowIso() });
  await note({ leadId: lead.id }, `Stage: ${from} → ${to}`, why);
}
async function runStep(row, step, lead, st, deps) {
  const CMP = require('./campaigns'); // eslint-disable-line global-require
  if (step.channel === 'email') {
    if (!lead.email) return { skip: 'no email' };
    if (await CMP.optedOut('email', lead.email)) return { skip: 'opted out' };
    const out = await realMail(deps)({ to: lead.email, subject: fillIn(step.subject, lead), text: fillIn(step.body, lead) + CMP.unsubscribeLine(lead.email) });
    return out && out.ok ? { ok: true, kind: 'email', subject: fillIn(step.subject, lead) } : { fail: (out && out.error) || 'the mail did not go' };
  }
  if (!lead.phone) return { skip: 'no phone' };
  if (await CMP.optedOut('whatsapp', lead.phone)) return { skip: 'opted out' };
  if (step.channel === 'sms') {
    const out = await sendSms(lead.phone, fillIn(step.body, lead), deps);
    return out && out.ok ? { ok: true, kind: 'note', subject: 'SMS sent', text: fillIn(step.body, lead) } : { fail: (out && (out.error || out.outcome)) || 'the SMS did not go' };
  }
  if (step.channel === 'whatsapp') {
    const out = await sendWa(lead, fillIn(step.body, lead), deps);
    return out && out.ok ? { ok: true, kind: 'whatsapp', subject: 'WhatsApp sent', text: fillIn(step.body, lead) } : { fail: (out && (out.error || out.outcome || out.reason)) || 'the WhatsApp did not go' };
  }
  // the AI call: the answer comes later (finishCalls)
  const place = deps.call || ((a) => require('../calling/omniCalls').create(a)); // eslint-disable-line global-require
  const out = await place({ externalId: `crm:${row.id}`, toNumber: lead.phone, name: lead.contactName || lead.company, script: st.callScript, agentName: 'CRM autopilot' });
  return out && out.ok ? { calling: out.id } : { fail: (out && out.reason) || 'the call was not placed' };
}

async function finishCalls(now, st, deps) {
  const look = deps.callStatus || ((id) => require('../calling/omniCalls').status(id)); // eslint-disable-line global-require
  const rows = await DB.all('SELECT * FROM "CrmAutoStep" WHERE "status" = \'calling\' LIMIT 50');
  let done = 0;
  for (const row of rows) {
    const c = await look(row.callId).catch(() => null); // eslint-disable-line no-await-in-loop
    if (!c || !c.ended) continue; // eslint-disable-line no-continue
    const lead = await S.getRow('lead', row.recordId); // eslint-disable-line no-await-in-loop
    done += 1;
    const interested = /^(yes|interested)$/i.test(String(c.interest || '')) || c.outcome === 'Interested';
    const no = c.outcome === 'Not Interested' || /^no$/i.test(String(c.interest || ''));
    await DB.run('UPDATE "CrmAutoStep" SET "status" = \'sent\', "result" = ? WHERE "id" = ?', String(c.outcome || c.status).slice(0, 200), row.id); // eslint-disable-line no-await-in-loop
    if (!lead) continue; // eslint-disable-line no-continue
    await note({ leadId: lead.id }, `AI call: ${c.outcome || c.status}`, c.summary, 'call'); // eslint-disable-line no-await-in-loop
    if (c.optOut) {
      const CMP = require('./campaigns'); // eslint-disable-line global-require
      /* eslint-disable no-await-in-loop */
      if (lead.email) await CMP.optOut('email', lead.email, { reason: 'Asked on the AI call not to be contacted' });
      if (lead.phone) await CMP.optOut('whatsapp', lead.phone, { reason: 'Asked on the AI call not to be contacted' });
      await moveLead(lead, 'Lost', 'Asked not to be contacted');
      /* eslint-enable no-await-in-loop */
    } else if (interested) {
      await moveLead(lead, 'Qualified', 'Interested on the AI call'); // eslint-disable-line no-await-in-loop
      if (st.meeting.on) await bookMeeting({ leadId: lead.id, name: lead.contactName || lead.company, email: lead.email, ownerId: lead.ownerId, ownerName: lead.ownerName, title: `Meeting with ${lead.company} - TeamLink` }, st, now, deps); // eslint-disable-line no-await-in-loop
    } else if (no) {
      await moveLead(lead, 'Lost', 'Not interested on the AI call'); // eslint-disable-line no-await-in-loop
    } else if (c.callBack && lead.ownerId) {
      const stamp = DB.nowIso();
      // eslint-disable-next-line no-await-in-loop
      await S.insert('CrmTask', { id: S.newId('task'), title: `Call back ${lead.company}`, dueDate: ymdOf(now + DAY), dueTime: '11:00', status: 'Open', type: 'Call', notifyApp: 1, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 15, leadId: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, createdAt: stamp, updatedAt: stamp });
    }
  }
  return done;
}

// customers: a check-in meeting every N days, counted from the last meeting (or from the day this was turned on)
async function customerMeetings(st, now, deps) {
  if (!st.meeting.on || !st.meeting.customerEveryDays || !st.armedAt) return 0;
  const since = new Date(now - st.meeting.customerEveryDays * DAY).toISOString();
  if (st.armedAt > since) return 0; // the first round comes N days after turning it on
  const rows = await DB.all(`SELECT a.* FROM "CrmAccount" a WHERE a."kind" = 'Client' AND a."name" NOT LIKE 'Sample%'
    AND NOT EXISTS (SELECT 1 FROM "CrmTask" t WHERE t."accountId" = a."id" AND t."type" = 'Meeting' AND t."createdAt" >= ?) LIMIT 5`, since);
  let n = 0;
  for (const a of rows) {
    const c = await DB.one('SELECT * FROM "CrmContact" WHERE "accountId" = ? AND "email" IS NOT NULL ORDER BY "createdAt" LIMIT 1', a.id); // eslint-disable-line no-await-in-loop
    const email = (c && c.email) || a.email;
    if (!email || await require('./campaigns').optedOut('email', email)) continue; // eslint-disable-line no-await-in-loop, no-continue, global-require
    await bookMeeting({ accountId: a.id, name: (c && c.name) || a.name, email, ownerId: a.ownerId, ownerName: a.ownerName, title: `Check-in with ${a.name} - TeamLink` }, st, now, deps); // eslint-disable-line no-await-in-loop
    n += 1;
  }
  return n;
}

// ---- they wrote back ----------------------------------------------------------------------------------------------
const STOP_MAIL = /^\s*(stop|stop all|unsubscribe|cancel|opt[- ]?out|remove me|do not (contact|mail|message)( me)?|don'?t (contact|mail|message)( me)?)\s*[.!]?\s*$/i;
const NOT_A_PERSON = /^\s*(out of (the )?office|automatic reply|auto.?reply|auto.?response|undeliverable)/i;
const CHANNEL_WORD = { Email: 'mail', SMS: 'SMS', WhatsApp: 'WhatsApp' };

async function leadsOf({ phone, email }) {
  const em = String(email || '').trim().toLowerCase();
  const ph = S.phone10(phone);
  if (em) return DB.all('SELECT * FROM "CrmLead" WHERE lower(trim("email")) = ? AND "status" != \'Junk\'', em);
  if (ph.length !== 10) return [];
  return (await DB.all('SELECT * FROM "CrmLead" WHERE "phone" LIKE ? AND "status" != \'Junk\'', `%${ph.slice(-4)}%`)).filter((l) => S.phone10(l.phone) === ph);
}
/**
 * A reply from a lead, whichever way it came (utils/messageDelivery.js, utils/imapInbox.js). The steps still waiting stop, the reply is on the timeline, and the owner gets the note on screen and a
 * follow-up to answer it. It runs with the automatic follow-through off as well: a reply is worth seeing either way. "stop" is an opt-out. Nothing is read into the words beyond that: a person decides.
 * -> how many leads it was
 */
// opts.wait: wait for the AI assistant's answer (tests); in a live inbound webhook it answers in the background, so the provider never waits for the model
async function onReply({ channel, phone, email, subject, text, stop = false }, { wait = false, deps = {} } = {}) {
  if (channel === 'Email' && NOT_A_PERSON.test(`${subject || ''}`)) return 0;
  const leads = await leadsOf({ phone, email });
  if (!leads.length) return 0;
  const body = S.clip(text, 1000);
  const wantsOut = stop || (channel === 'Email' && STOP_MAIL.test(String(text || '')));
  // the AI sales assistant answers instead of a person (crm/salesAgent.js): then no "Answer ..." follow-up is made; it hands over when a person is needed
  const SA = require('./salesAgent'); // eslint-disable-line global-require
  const aiAnswers = !wantsOut && (await SA.load()).on;
  const CMP = require('./campaigns'); // eslint-disable-line global-require
  const names = SALES.stageNames(await SETTINGS.load());
  const word = CHANNEL_WORD[channel] || channel;
  const managers = (await S.ownerOptions()).filter((o) => o.tl).map((o) => o.id);
  for (const lead of leads) {
    /* eslint-disable no-await-in-loop */
    // paused as well, so a lead who writes before their first step is queued is not started afterwards
    await S.update('CrmLead', lead.id, { autoPaused: 1, updatedAt: DB.nowIso() });
    await DB.run('UPDATE "CrmAutoStep" SET "status" = \'stopped\', "result" = ? WHERE "recordId" = ? AND "status" = \'waiting\'', wantsOut ? 'they asked us to stop' : `they replied on ${word}`, lead.id);
    await note({ leadId: lead.id }, wantsOut ? `Asked us to stop (${word})` : `Replied on ${word}`, body, channel === 'Email' ? 'email' : (channel === 'WhatsApp' ? 'whatsapp' : 'note'));
    if (wantsOut) {
      if (lead.email) await CMP.optOut('email', lead.email, { reason: `Asked us to stop by ${word}` });
      if (lead.phone) await CMP.optOut('whatsapp', lead.phone, { reason: `Asked us to stop by ${word}` });
      if (lead.status !== 'Converted' && SALES.stageOf(lead, names) !== 'Won') await moveLead(lead, 'Lost', 'Asked us to stop');
    } else if (SALES.stageOf(lead, names) === names[0]) await moveLead(lead, 'Contacted', `Replied on ${word}`);
    const to = lead.ownerId ? [lead.ownerId] : managers;
    const stamp = Date.now();
    for (const userId of to) {
      await prisma.notification.create({
        data: {
          userId, title: wantsOut ? `${lead.company} asked us to stop` : `${lead.company} replied on ${word}`, message: `${body || ''}\nOpen: /crm/leads?open=lead:${lead.id}`.trim(), channel: 'In-App', recipient: `crm-reply|${lead.id}|${stamp}`, status: 'Sent',
        },
      }).catch(() => {});
    }
    // one follow-up however many messages they send: a person answers them all at once
    const open = !wantsOut && lead.ownerId && await DB.one('SELECT "id" FROM "CrmTask" WHERE "leadId" = ? AND "status" = \'Open\' AND "title" LIKE \'Answer %\'', lead.id);
    if (!wantsOut && lead.ownerId && !open && !aiAnswers) {
      const iso = new Date(stamp + 5.5 * HOUR).toISOString();
      const now = DB.nowIso();
      await S.insert('CrmTask', {
        id: S.newId('task'), title: `Answer ${lead.contactName || lead.company}: replied on ${word}`, dueDate: iso.slice(0, 10), dueTime: iso.slice(11, 16), status: 'Open', type: channel === 'Email' ? 'Email' : (channel === 'WhatsApp' ? 'WhatsApp' : 'Other'),
        notifyApp: 0, notifyWhatsapp: 0, notifySms: 0, notifyLead: 0, remindBefore: 0, reminderSentAt: DB.nowIso(), leadId: lead.id, ownerId: lead.ownerId, ownerName: lead.ownerName, createdAt: now, updatedAt: now,
      }).catch(() => null);
    }
    /* eslint-enable no-await-in-loop */
  }
  if (aiAnswers) {
    const lead = await DB.one('SELECT * FROM "CrmLead" WHERE "id" = ?', leads[0].id);
    const job = SA.respond({ channel, lead, message: text, subject }, { deps }).catch((e) => { console.error('[crm] AI assistant:', e.message); return null; }); // eslint-disable-line no-console
    if (wait) await job;
  }
  return leads.length;
}

// Nothing else reads the mailbox by itself, and a mail reply has to be seen for the sequence to stop. Only while the automatic follow-through is on, and only when a mailbox is connected.
async function checkMailbox({ pollOnce } = {}) {
  const st = await load();
  // the AI assistant answers mail too, so the mailbox is read while either is on
  if (!st.on && !(await require('./salesAgent').load()).on) return { off: true }; // eslint-disable-line global-require
  // eslint-disable-next-line global-require
  const imap = require('../utils/imapInbox');
  if (!pollOnce && !(await imap.status()).configured) return { notConfigured: true };
  return (pollOnce || imap.pollOnce)();
}

/** One pass. -> what was done. Does nothing while it is off. */
async function tick({ now = Date.now(), deps = {} } = {}) {
  const st = await load();
  if (!st.on || !st.armedAt) return { off: true };
  const out = { queued: 0, sent: 0, failed: 0, skipped: 0, stopped: 0, calls: 0, callsDone: 0, customers: 0, quiet: false };
  // new leads get their steps
  const steps = st.steps.filter((x) => x.on);
  const fresh = await DB.all(`SELECT l."id", l."createdAt" FROM "CrmLead" l WHERE l."createdAt" >= ? AND l."status" IN ('New', 'Contacted') AND l."company" NOT LIKE 'Sample%' AND COALESCE(l."autoPaused", 0) = 0
    AND NOT EXISTS (SELECT 1 FROM "CrmAutoStep" s WHERE s."recordId" = l."id") LIMIT 100`, st.armedAt);
  for (const l of fresh) {
    for (const x of steps) {
      // eslint-disable-next-line no-await-in-loop
      await DB.run('INSERT OR IGNORE INTO "CrmAutoStep" ("id", "recordId", "stepId", "dueAt", "status", "createdAt") VALUES (?, ?, ?, ?, \'waiting\', ?)', S.newId('auto'), l.id, x.id, new Date(Date.parse(l.createdAt) + x.afterHours * HOUR).toISOString(), DB.nowIso());
      out.queued += 1;
    }
  }
  out.callsDone = await finishCalls(now, st, deps);
  if (await quietNow(now)) { out.quiet = true; return out; } // nothing new goes out at night; it waits
  const names = SALES.stageNames(await SETTINGS.load());
  const due = await DB.all('SELECT * FROM "CrmAutoStep" WHERE "status" = \'waiting\' AND "dueAt" <= ? ORDER BY "dueAt" LIMIT ?', new Date(now).toISOString(), MAX_PER_TICK);
  for (const row of due) {
    /* eslint-disable no-await-in-loop */
    const claimed = await DB.run('UPDATE "CrmAutoStep" SET "status" = \'sending\' WHERE "id" = ? AND "status" = \'waiting\'', row.id);
    if (Number(claimed) !== 1) continue; // eslint-disable-line no-continue
    const lead = await S.getRow('lead', row.recordId);
    const stop = await stopReason(lead, names, deps);
    const step = st.steps.find((x) => x.id === row.stepId);
    if (stop || !step || !step.on) {
      await DB.run('UPDATE "CrmAutoStep" SET "status" = \'stopped\', "result" = ? WHERE "id" = ?', stop || 'this step is switched off', row.id);
      out.stopped += 1;
      continue; // eslint-disable-line no-continue
    }
    const r = await runStep(row, step, lead, st, deps).catch((e) => ({ fail: e.message }));
    if (r.calling) {
      await DB.run('UPDATE "CrmAutoStep" SET "status" = \'calling\', "callId" = ? WHERE "id" = ?', r.calling, row.id);
      out.calls += 1;
      await note({ leadId: lead.id }, 'AI call placed', null, 'call');
    } else if (r.ok) {
      await DB.run('UPDATE "CrmAutoStep" SET "status" = \'sent\', "sentAt" = ? WHERE "id" = ?', DB.nowIso(), row.id);
      out.sent += 1;
      await note({ leadId: lead.id }, r.subject, r.text, r.kind);
      if (SALES.stageOf(lead, names) === names[0]) await moveLead(lead, 'Contacted', 'Reached automatically');
    } else {
      await DB.run('UPDATE "CrmAutoStep" SET "status" = ?, "result" = ? WHERE "id" = ?', r.skip ? 'skipped' : 'failed', String(r.skip || r.fail).slice(0, 300), row.id);
      if (r.skip) out.skipped += 1; else { out.failed += 1; await note({ leadId: lead.id }, `${step.channel} did not go`, String(r.fail).slice(0, 300)); }
    }
    /* eslint-enable no-await-in-loop */
  }
  out.customers = await customerMeetings(st, now, deps);
  return out;
}

module.exports = {
  DEFAULTS, clean, load, get, save, pauseLead, tick, bookMeeting, nextSlot, calendarFile, onReply, checkMailbox,
};
