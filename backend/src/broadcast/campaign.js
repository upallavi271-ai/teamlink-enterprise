// ---------------------------------------------------------------------------
// JOB BROADCAST CAMPAIGN: send the job's WhatsApp message to a contact list, paced, with results.
//   plan()      what would happen (counts, skipped reasons, preview with a real contact, ETA) - sends nothing
//   create()    writes the campaign (DRAFT) with one row per contact
//   start()     the user's click: needs consent on the list, the master switch (Company setup, default OFF), the
//               WhatsApp company switch, a connected provider (and, on the official API, an approved template)
//   tick()      sends the next message(s) of every RUNNING campaign within the caps and the gaps; nothing runs on its own
//               for a campaign nobody started. A campaign nobody started does not exist, so on a fresh database the
//               timer never starts.
//   pause / resume / cancel
// The send itself goes through channels/send.js (the WhatsApp + SMS module): STOP list, provider choice, caps and the
// communication log are theirs. One message per contact per job (bc.jobsent.<job>).
// Row states: queued -> sending (accepted by the provider's queue) -> sent -> delivered -> read | failed | skipped.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const L = require('./lists');
const T = require('./template');
const intent = require('./intent');
const { logAudit } = require('../utils/audit');
const sandbox = require('../utils/sandbox');

const ACTIVE = ['SCHEDULED', 'RUNNING'];
const SKIP_WORDS = {
  invalid: 'Invalid number', no_phone: 'No phone number', dup_in_file: 'Duplicate in the file', stop: 'On the STOP list', no_consent: 'No permission',
  already_sent: 'Already got this requirement', quiet: 'Quiet hours', cancelled: 'Cancelled',
};
const rowsKey = (id) => `bc.crow.${id}`;
const campKey = (id) => `bc.camp.${id}`;
const clean = (v) => String(v == null ? '' : v).trim();

// ---- the channel: which provider, the caps, what the first message needs -------
async function channelState() {
  if (sandbox.isSandbox()) {
    return { ok: true, provider: 'sandbox', label: 'Test mode: nothing is really sent', official: false, caps: { perDay: 150, perHour: 30, gapMin: 0, gapMax: 0 }, needsTemplate: false, sandbox: true };
  }
  const settings = require('../channels/settings'); // eslint-disable-line global-require
  const channels = require('../channels'); // eslint-disable-line global-require
  const s = await settings.load({ fresh: true });
  if (!s.switches.WhatsApp) return { ok: false, reason: 'WhatsApp is switched off for the company (Integrations > WhatsApp & SMS).', provider: null };
  const st = await channels.status('WhatsApp');
  if (!st.configured) return { ok: false, reason: `Not connected: set up WhatsApp in Integrations. ${st.reason || ''}`.trim(), provider: null };
  if (st.provider === 'whatsapp.qr') {
    const q = settings.effectiveQr(s);
    if (q.killSwitch) return { ok: false, reason: 'The QR WhatsApp kill switch is ON.', provider: st.provider };
    return { ok: true, provider: st.provider, label: st.via, official: false, caps: { perDay: q.perDay, perHour: q.perHour, gapMin: q.gapMin, gapMax: q.gapMax }, needsTemplate: false, risk: 'The QR-linked number is unofficial. Sending to many people can get the number banned by WhatsApp. Use a spare number.' };
  }
  const lim = (await require('../utils/messageLimits').load()).WhatsApp; // eslint-disable-line global-require
  const gap = Math.max(1, Math.round(60 / (lim.perMinute || 60)));
  return { ok: true, provider: st.provider, label: st.via, official: true, caps: { perDay: lim.perDay, perHour: Math.min(lim.perDay, lim.perMinute * 60), gapMin: gap, gapMax: gap }, needsTemplate: true };
}

async function approvedTemplates() {
  const T0 = require('../utils/messageTemplates'); // eslint-disable-line global-require
  if (!T0.supported()) return [];
  const rows = await prisma.messageTemplate.findMany({ where: { channel: 'WhatsApp', active: true, waStatus: 'Approved' }, orderBy: { updatedAt: 'desc' }, take: 50 });
  return rows.map((r) => ({ id: r.id, name: r.name, waTemplateName: r.waTemplateName, waLanguageCode: r.waLanguageCode || 'en', body: r.body, waVars: r.waVars ? JSON.parse(r.waVars) : [] }));
}

async function sentToday() { return (await S.get(`bc.day.${S.dayKey()}`, { n: 0, h: {} })); }

// ETA: how many days at the daily cap, and the first-N-today choice
function eta(count, caps, { firstN } = {}) {
  const perDay = Math.max(1, caps.perDay || 150);
  const days = Math.ceil(count / perDay);
  const hoursPerDay = Math.max(1, 12); // 9:00 - 21:00 quiet-hours window
  const gapAvg = ((caps.gapMin || 0) + (caps.gapMax || 0)) / 2;
  const todayMax = Math.min(perDay, caps.perHour * hoursPerDay);
  const secs = gapAvg * Math.min(count, todayMax);
  return {
    perDay, days, firstNToday: firstN || null, todayCount: Math.min(count, firstN || perDay),
    words: `${count} messages at ${perDay} a day take about ${days} day${days === 1 ? '' : 's'}${gapAvg ? ` (one message every ${Math.round(gapAvg)} seconds, ${Math.round(secs / 60)} minutes of sending on the first day)` : ''}.`,
  };
}

async function jobFor(user, jobId) {
  const r = await prisma.requirement.findUnique({ where: { id: String(jobId) }, include: { client: true } });
  if (!r) return { error: 'Requirement not found.', status: 404 };
  const access = require('../jobPublish/access'); // eslint-disable-line global-require
  if (!access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
  if (!(await A.mayViewJob(user, r))) return { error: 'HR can only use internal requirements here.', status: 403 };
  return { r };
}

// The text the contacts get = the ready template's WhatsApp text of the version in use.
async function textFor(user, r, base) {
  const { version } = await T.ensure(user, r, base);
  return { text: version.texts.whatsapp, sms: version.texts.sms, version: version.v };
}
const baseOf = (req) => process.env.APP_BASE_URL || (req && req.get && req.get('origin')) || '';
const applyLinkOf = (r, base) => `${base || process.env.APP_BASE_URL || ''}${require('../utils/jobSlug').careersPath(r, 'WhatsApp')}`;

function merge(text, contact, r, base) {
  return T.render(text, { firstName: T.firstNameOf(contact.name), name: contact.name, jobTitle: clean(r.title), location: clean(r.location), applyLink: applyLinkOf(r, base) });
}

// ---- plan ----------------------------------------------------------------------------
// opts: { text?, templateId?, firstN?, mode: 'now'|'at'|'spread', startAt?, spreadHours?, smsFallback? }
async function plan(user, listId, jobId, opts = {}, base = '') {
  const list = await L.getList(user, listId);
  if (!list || list.deletedAt) return { error: 'This contact list was not found.', status: 404 };
  const j = await jobFor(user, jobId);
  if (j.error) return j;
  const { r } = j;
  const contacts = await S.get(`bc.contacts.${listId}`, []);
  const ledger = await S.get(`bc.jobsent.${r.id}`, {});
  const ch = await channelState();
  const settings = await S.settings();
  const stops = await L.stopSet();
  const skipped = { invalid: 0, stop: 0, duplicates: 0, no_phone: 0, no_consent: 0, already_sent: 0 };
  const sendable = [];
  for (const c of contacts) {
    if (!L.SENDABLE.has(c.status)) {
      if (c.status === 'invalid') skipped.invalid += 1; else if (c.status === 'stop') skipped.stop += 1; else if (c.status === 'dup_in_file') skipped.duplicates += 1; else if (c.status === 'no_phone') skipped.no_phone += 1; else skipped.no_consent += 1;
    } else if (ledger[c.phone]) skipped.already_sent += 1;
    else if (stops.has(c.phone)) skipped.stop += 1;
    else sendable.push(c);
  }
  skipped.duplicates += skipped.already_sent;
  const t = await textFor(user, r, base);
  const text = opts.text ? String(opts.text).slice(0, 1500) : t.text;
  const sample = sendable[0] || contacts.find((c) => c.phone) || { name: 'Anita Rao' };
  const caps = ch.caps || { perDay: 150, perHour: 30, gapMin: 8, gapMax: 20 };
  const count = sendable.length;
  const templates = ch.official ? await approvedTemplates() : [];
  const needTpl = !!ch.needsTemplate && !templates.length;
  const total = count + Object.values(skipped).reduce((a, b) => a + b, 0) - skipped.already_sent;
  const skipTotal = contacts.length - count;
  const blockers = [];
  if (!settings.master) blockers.push({ code: 'MASTER_OFF', words: 'Requirement broadcasts are switched OFF. An Admin turns them on in Contact lists > Settings.' });
  if (!list.consent) blockers.push({ code: 'NO_CONSENT', words: 'Tick the permission box for this list first.' });
  if (!ch.ok) blockers.push({ code: 'NOT_CONNECTED', words: ch.reason });
  if (needTpl) blockers.push({ code: 'NO_TEMPLATE', words: 'The official WhatsApp API needs an approved message template for the first message. Ask an Admin to add one in Message templates and mark it Approved.' });
  if (!count) blockers.push({ code: 'NOBODY', words: 'There is nobody left to send to.' });
  if (!['bde', 'tl', 'bdetl', 'admin'].includes(A.kind(user))) blockers.push({ code: 'ROLE', words: 'You can look but not send.' });
  const live = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(r.status);
  if (!live) blockers.push({ code: 'JOB_NOT_LIVE', words: 'This requirement is not open, so it cannot be sent to a list yet.' });
  return {
    list: { id: list.id, name: list.name, consent: list.consent }, job: { id: r.id, title: r.title, code: r.reqCode, status: r.status },
    channel: { ok: ch.ok, label: ch.label || null, provider: ch.provider, official: !!ch.official, sandbox: !!ch.sandbox, reason: ch.ok ? null : ch.reason, risk: ch.risk || null, caps },
    counts: { total: contacts.length, willSend: count, skipped: skipTotal, skippedBy: { invalid: skipped.invalid, stop: skipped.stop, duplicates: skipped.duplicates, no_phone: skipped.no_phone, no_permission: skipped.no_consent } },
    words: `Will send to ${count} of ${contacts.length} (${skipTotal} skipped: invalid ${skipped.invalid}, STOP ${skipped.stop}, duplicates ${skipped.duplicates}, no phone ${skipped.no_phone}${skipped.no_consent ? `, no permission ${skipped.no_consent}` : ''})`,
    eta: eta(count, caps, { firstN: Number(opts.firstN) || null }), templates, needsTemplate: needTpl, blockers, canStart: !blockers.length,
    text, preview: { contact: { name: sample.name, phone: A.masked(user) ? require('../utils/messagingCore').maskMobile(sample.phone) : (sample.phone ? `+${sample.phone}` : '') }, message: merge(text, sample, r, base) },
    master: settings.master, quiet: settings.quiet, version: t.version, total,
  };
}

// ---- create / start ----------------------------------------------------------------------
async function create(user, listId, jobId, opts = {}, base = '') {
  if (!A.mayRun(user)) return { error: 'Sending requirements to a contact list is done by a team lead, a client manager or an Admin.', status: 403 };
  const p = await plan(user, listId, jobId, opts, base);
  if (p.error) return p;
  const { r } = await jobFor(user, jobId);
  const list = await L.getList(user, listId);
  const contacts = await S.get(`bc.contacts.${listId}`, []);
  const ledger = await S.get(`bc.jobsent.${r.id}`, {});
  const id = S.newId('cm');
  const stopSet = await L.stopSet();
  const rows = [];
  for (const c of contacts) {
    const row = { i: c.i, phone: c.phone, name: c.name, st: 'queued', why: '', ref: null, at: null, replied: false, intent: null };
    if (!L.SENDABLE.has(c.status)) { row.st = 'skipped'; row.why = c.status === 'dup_in_file' ? 'Duplicate in the file' : (L.STATUS_WORDS[c.status] || c.status); } else if (ledger[c.phone]) { row.st = 'skipped'; row.why = 'Already got this requirement'; } else if (stopSet.has(c.phone)) { row.st = 'skipped'; row.why = 'On the STOP list'; }
    rows.push(row);
  }
  // WHATSAPP NUMBER (utils/waNumbers.js): the sender's own number, or one they are allowed to use; kept on the campaign
  let waNumber = null;
  try {
    const wr = await require('../utils/waNumbers').planNumber(user, { requestedNumberId: opts.waNumberId || null }); // eslint-disable-line global-require
    if (!wr.legacy && !wr.ok) return { error: wr.error, status: wr.status || 409, code: wr.code };
    if (wr.ok) waNumber = { id: wr.number.id, label: wr.number.label };
  } catch { waNumber = null; }
  const mode = ['now', 'at', 'spread'].includes(opts.mode) ? opts.mode : 'now';
  let startAt = null;
  if (mode === 'at') {
    startAt = Date.parse(opts.startAt);
    if (!startAt || startAt < Date.now() - 60000) return { error: 'Choose a time in the future to send at.', status: 400 };
  }
  const camp = {
    id, listId, listName: list.name, listSource: list.source, jobId: r.id, jobTitle: r.title, jobCode: r.reqCode, internal: !!r.internal,
    text: p.text, version: p.version, templateId: opts.templateId || null, channel: 'WhatsApp', smsFallback: !!opts.smsFallback,
    mode, startAt: startAt ? new Date(startAt).toISOString() : null, spreadHours: mode === 'spread' ? Math.min(240, Math.max(1, Number(opts.spreadHours) || 8)) : null,
    firstN: Number(opts.firstN) > 0 ? Math.floor(Number(opts.firstN)) : null, base: base || '',
    status: 'DRAFT', createdAt: new Date().toISOString(), createdById: user.id, createdByName: user.name, ownerId: list.ownerId, provider: p.channel.provider, note: '',
    todayKey: null, todayCount: 0, waNumberId: waNumber ? waNumber.id : null, waNumberLabel: waNumber ? waNumber.label : null,
  };
  await S.put(rowsKey(id), rows);
  await S.put(campKey(id), camp, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Requirement broadcast created', entity: 'Campaign', entityId: id, toValue: `${r.title} to list "${list.name}" · ${p.counts.willSend} of ${p.counts.total} will be sent`.slice(0, 480) });
  return { campaign: camp };
}

async function getCamp(user, id) {
  if (!/^cm[a-z0-9]{6,30}$/.test(String(id))) return null;
  const c = await S.get(campKey(id));
  if (!c) return null;
  if (!A.seesAll(user) && c.createdById !== user.id && c.ownerId !== user.id) {
    // a team lead / BDE sees a campaign on a job in their area
    const r = await prisma.requirement.findUnique({ where: { id: c.jobId } });
    const access = require('../jobPublish/access'); // eslint-disable-line global-require
    if (!r || !access.inScope(user, r)) return null;
  }
  if (A.kind(user) === 'hr' && !c.internal) return null;
  return c;
}

async function start(user, id) {
  if (!A.mayRun(user)) return { error: 'Sending is done by a team lead, a client manager or an Admin.', status: 403 };
  const c = await getCamp(user, id);
  if (!c) return { error: 'This campaign was not found.', status: 404 };
  if (!['DRAFT', 'PAUSED'].includes(c.status)) return { error: `This campaign is ${c.status.toLowerCase()}.`, status: 409 };
  const list = await L.getList(user, c.listId);
  if (!list || list.deletedAt) return { error: 'The contact list is gone.', status: 404 };
  const p = await plan(user, c.listId, c.jobId, { text: c.text, templateId: c.templateId }, c.base);
  if (p.error) return p;
  const hard = p.blockers.filter((b) => b.code !== 'NOBODY' || c.status === 'DRAFT');
  if (hard.length) return { error: hard.map((b) => b.words).join(' '), code: hard[0].code, status: 409, blockers: hard };
  const now = Date.now();
  const scheduled = c.mode === 'at' && c.startAt && Date.parse(c.startAt) > now;
  const next = { ...c, status: scheduled ? 'SCHEDULED' : 'RUNNING', startedAt: c.startedAt || new Date().toISOString(), startedById: user.id, startedByName: user.name, note: '' };
  await S.put(campKey(c.id), next, user);
  await logAudit({ userId: user.id, actorName: user.name, action: scheduled ? 'Requirement broadcast scheduled' : 'Requirement broadcast started', entity: 'Campaign', entityId: c.id, reason: list.consent ? list.consent.basis : '', toValue: `${c.jobTitle} to "${c.listName}" (list ${c.listId}) · ${p.counts.willSend} people · ${p.channel.label || p.channel.provider}${scheduled ? ` · at ${c.startAt}` : ''}`.slice(0, 480) });
  ensureTimer();
  return { campaign: next };
}
async function setStatus(user, id, from, to, action) {
  if (!A.mayRun(user)) return { error: 'Not allowed.', status: 403 };
  const c = await getCamp(user, id);
  if (!c) return { error: 'This campaign was not found.', status: 404 };
  if (!from.includes(c.status)) return { error: `This campaign is ${c.status.toLowerCase()}, so it cannot be ${action.toLowerCase()}.`, status: 409 };
  if (to === 'CANCELLED') {
    await S.update(rowsKey(id), [], (rows) => rows.map((r) => (r.st === 'queued' ? { ...r, st: 'skipped', why: 'Cancelled' } : r)));
  }
  const next = { ...c, status: to, ...(to === 'CANCELLED' ? { endedAt: new Date().toISOString() } : {}) };
  await S.put(campKey(id), next, user);
  await logAudit({ userId: user.id, actorName: user.name, action: `Requirement broadcast ${action.toLowerCase()}`, entity: 'Campaign', entityId: id, toValue: `${c.jobTitle} to "${c.listName}"` });
  if (to === 'RUNNING') ensureTimer();
  return { campaign: next };
}
const pause = (u, id) => setStatus(u, id, ['RUNNING', 'SCHEDULED'], 'PAUSED', 'Paused');
const resume = async (u, id) => { const c = await getCamp(u, id); if (c && c.status === 'PAUSED') return start(u, id); return setStatus(u, id, ['PAUSED'], 'RUNNING', 'Resumed'); };
const cancel = (u, id) => setStatus(u, id, ['DRAFT', 'RUNNING', 'SCHEDULED', 'PAUSED'], 'CANCELLED', 'Cancelled');

// ---- the send ---------------------------------------------------------------------------
async function transport(camp, row, text, r) {
  if (sandbox.isSandbox()) {
    // never transmitted. A contact whose name holds FAILTEST fails, QUEUEDTEST is accepted into a provider queue (tests only).
    if (/FAILTEST/i.test(row.name || '')) return { ok: false, error: 'Test failure', transient: false };
    if (/NOCONFTEST/i.test(row.name || '')) return { ok: false, notConfigured: true, error: 'Not connected' };
    return { ok: true, provider: 'SANDBOX', providerRef: `sandbox-bc-${Date.now().toString(36)}-${row.i}`, queued: /QUEUEDTEST/i.test(row.name || '') };
  }
  const send = require('../channels/send'); // eslint-disable-line global-require
  const meta = { audience: 'contacts', personName: row.name, purpose: 'job-broadcast', campaignId: camp.id, jobId: camp.jobId, senderUserId: camp.startedById, senderName: camp.startedByName, template: 'Requirement broadcast' };
  let template;
  if (camp.templateId) {
    const T0 = require('../utils/messageTemplates'); // eslint-disable-line global-require
    const t = await T0.resolve({ templateId: camp.templateId, channel: 'WhatsApp' });
    if (t && t.waTemplateName && t.waStatus === 'Approved') {
      const vals = { firstName: T.firstNameOf(row.name), name: row.name, role: r.title, jobTitle: r.title, venue: r.location, location: r.location, jobLink: applyLinkOf(r, camp.base), applyLink: applyLinkOf(r, camp.base), company: 'TeamLink Consultants' };
      template = { name: t.waTemplateName, language: t.waLanguageCode || 'en', vars: T0.waVarList(t).map((k) => vals[k] || '-') };
    }
  }
  return send.sendWhatsApp({ to: row.phone, text, template, meta, numberId: camp.waNumberId || undefined });
}
async function smsTransport(camp, row, r) {
  if (sandbox.isSandbox()) return { ok: true, provider: 'SANDBOX', providerRef: `sandbox-bcsms-${Date.now().toString(36)}-${row.i}` };
  const send = require('../channels/send'); // eslint-disable-line global-require
  const v = await T.ensure({ id: camp.createdById, name: camp.createdByName }, r, camp.base);
  return send.sendSms({ to: row.phone, text: merge(v.version.texts.sms, row, r, camp.base), meta: { audience: 'contacts', personName: row.name, purpose: 'job-broadcast', campaignId: camp.id, jobId: camp.jobId } });
}

const gapMs = (ch, camp, total) => {
  const c = ch.caps || {};
  let s = (c.gapMin || 0) + Math.random() * Math.max(0, (c.gapMax || 0) - (c.gapMin || 0));
  if (camp.mode === 'spread' && camp.spreadHours && total) s = Math.max(s, (camp.spreadHours * 3600) / total);
  return Math.round(s * 1000);
};
const nextAt = new Map();

async function bump(counter, hourKey) {
  await S.update(`bc.day.${S.dayKey()}`, { n: 0, h: {} }, (d) => { d.n += 1; d.h[hourKey] = (d.h[hourKey] || 0) + 1; return d; });
  void counter; // eslint-disable-line no-void
}

// opts (tests): { now, ignoreGap, ignoreQuiet, max }
async function tick(opts = {}) {
  const now = opts.now || Date.now();
  const settings = await S.settings();
  if (!settings.master) return { skipped: 'The master switch is OFF.', sent: 0 };
  const ids = (await S.keys('bc.camp.')).map((k) => k.slice('bc.camp.'.length));
  let sent = 0; let touched = 0;
  const ch = await channelState();
  for (const id of ids) {
    let c = await S.get(campKey(id)); // eslint-disable-line no-await-in-loop
    if (!c || !ACTIVE.includes(c.status)) continue; // eslint-disable-line no-continue
    touched += 1;
    // the number chosen for this campaign was switched off / taken from its owner: the campaign WAITS with the reason; it never sends from another number
    if (c.waNumberId && !require('../utils/sandbox').isSandbox()) { // eslint-disable-line global-require
      const ck = await require('../utils/waNumbers').recheck(c.waNumberId, c.startedById || c.createdById).catch(() => ({ ok: true })); // eslint-disable-line no-await-in-loop, global-require
      if (!ck.ok) { await S.put(campKey(id), { ...c, status: 'PAUSED', note: `Paused: ${ck.error}` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    }
    if (c.status === 'SCHEDULED') {
      if (c.startAt && Date.parse(c.startAt) > now) continue; // eslint-disable-line no-continue
      c = { ...c, status: 'RUNNING' }; await S.put(campKey(id), c); // eslint-disable-line no-await-in-loop
    }
    if (!ch.ok) { if (c.note !== ch.reason) await S.put(campKey(id), { ...c, note: ch.reason }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    const hour = S.istHour(now);
    if (!opts.ignoreQuiet && (hour >= settings.quiet.from || hour < settings.quiet.to)) { if (c.note !== 'Quiet hours: sending continues at 9 am.') await S.put(campKey(id), { ...c, note: 'Quiet hours: sending continues at 9 am.' }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    const today = await sentToday(); // eslint-disable-line no-await-in-loop
    const hourKey = `${S.dayKey(now)}${String(hour).padStart(2, '0')}`;
    const caps = ch.caps;
    if (today.n >= caps.perDay) { if (!c.note || !/daily limit/i.test(c.note)) await S.put(campKey(id), { ...c, note: `Today's limit of ${caps.perDay} messages is reached. Sending continues tomorrow.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    if ((today.h[hourKey] || 0) >= caps.perHour) continue; // eslint-disable-line no-continue
    const dk = S.dayKey(now);
    if (c.firstN && c.todayKey === dk && c.todayCount >= c.firstN) { if (!c.note || !/first/i.test(c.note)) await S.put(campKey(id), { ...c, note: `The first ${c.firstN} for today are sent. The rest goes out tomorrow.` }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    if (!opts.ignoreGap && (nextAt.get(id) || 0) > now) continue; // eslint-disable-line no-continue
    const rows = await S.get(rowsKey(id), []); // eslint-disable-line no-await-in-loop
    const idx = rows.findIndex((x) => x.st === 'queued');
    if (idx < 0) {
      if (!rows.some((x) => x.st === 'sending')) { await S.put(campKey(id), { ...c, status: 'DONE', endedAt: new Date().toISOString(), note: '' }); await finished(c); } // eslint-disable-line no-await-in-loop
      continue; // eslint-disable-line no-continue
    }
    const row = rows[idx];
    // last checks right before the send
    let skipWhy = null;
    if (await L.isStopped(row.phone)) skipWhy = 'On the STOP list'; // eslint-disable-line no-await-in-loop
    const jl = await S.get(`bc.jobsent.${c.jobId}`, {}); // eslint-disable-line no-await-in-loop
    if (!skipWhy && jl[row.phone] && jl[row.phone] !== c.id) skipWhy = 'Already got this requirement';
    if (skipWhy) { await setRow(id, row.i, { st: 'skipped', why: skipWhy }); continue; } // eslint-disable-line no-await-in-loop, no-continue
    // reserve the contact for this job BEFORE sending: a restart can never send it twice
    await S.update(`bc.jobsent.${c.jobId}`, {}, (d) => { d[row.phone] = c.id; return d; }); // eslint-disable-line no-await-in-loop
    await setRow(id, row.i, { st: 'sending', at: new Date().toISOString() }); // eslint-disable-line no-await-in-loop
    const r = await prisma.requirement.findUnique({ where: { id: c.jobId }, include: { client: true } }); // eslint-disable-line no-await-in-loop
    const text = merge(c.text, row, r, c.base);
    let res = await transport(c, row, text, r); // eslint-disable-line no-await-in-loop
    if (!res.ok && c.smsFallback && !res.invalid && !res.notConfigured) { const s2 = await smsTransport(c, row, r); if (s2.ok) res = { ...s2, viaSms: true }; } // eslint-disable-line no-await-in-loop
    if (res.ok) {
      await setRow(id, row.i, { st: res.queued ? 'sending' : 'sent', ref: res.providerRef || null, at: new Date().toISOString(), why: res.viaSms ? 'Sent by SMS' : (res.queued ? 'Waiting in the WhatsApp sending queue' : '') }); // eslint-disable-line no-await-in-loop
      await bump('n', hourKey); // eslint-disable-line no-await-in-loop
      sent += 1;
      const cc = { ...c, todayKey: dk, todayCount: (c.todayKey === dk ? c.todayCount : 0) + 1, note: '' };
      await S.put(campKey(id), cc); // eslint-disable-line no-await-in-loop
      nextAt.set(id, now + (opts.ignoreGap ? 0 : gapMs(ch, c, rows.length)));
    } else if (res.notConfigured) {
      await S.update(`bc.jobsent.${c.jobId}`, {}, (d) => { delete d[row.phone]; return d; }); // eslint-disable-line no-await-in-loop
      await setRow(id, row.i, { st: 'queued', why: '' }); // eslint-disable-line no-await-in-loop
      await S.put(campKey(id), { ...c, status: 'PAUSED', note: `Paused: ${res.error || 'WhatsApp is not connected.'}` }); // eslint-disable-line no-await-in-loop
    } else if (res.transient) {
      const tries = (row.tries || 0) + 1;
      await S.update(`bc.jobsent.${c.jobId}`, {}, (d) => { if (tries < 3) delete d[row.phone]; return d; }); // eslint-disable-line no-await-in-loop
      await setRow(id, row.i, tries < 3 ? { st: 'queued', tries, why: 'Will try again' } : { st: 'failed', tries, why: String(res.error || 'The provider is busy').slice(0, 200) }); // eslint-disable-line no-await-in-loop
      nextAt.set(id, now + 30000);
    } else {
      await setRow(id, row.i, { st: res.invalid ? 'skipped' : 'failed', why: String(res.error || 'Could not be sent').slice(0, 200) }); // eslint-disable-line no-await-in-loop
    }
    if (opts.max && sent >= opts.max) break;
  }
  return { sent, campaigns: touched };
}
async function setRow(campId, i, patch) {
  return S.update(rowsKey(campId), [], (rows) => { const k = rows.findIndex((x) => x.i === i); if (k < 0) return undefined; rows[k] = { ...rows[k], ...patch }; return rows; });
}
async function finished(c) {
  try {
    const { notifyUsers } = require('../utils/notify'); // eslint-disable-line global-require
    await notifyUsers([c.createdById], { title: 'Requirement broadcast finished', message: `${c.jobTitle} to "${c.listName}" has been sent to everyone it could be sent to. Open Contact lists > Campaigns to see the results.` });
    await logAudit({ userId: null, actorName: 'TeamLink', action: 'Requirement broadcast finished', entity: 'Campaign', entityId: c.id, toValue: `${c.jobTitle} to "${c.listName}"` });
  } catch { /* the bell is a helper */ }
}

// ---- the timer: only when a campaign somebody started is waiting ---------------------------
let timer = null;
async function hasActive() { for (const k of await S.keys('bc.camp.')) { const c = await S.get(k); if (c && ACTIVE.includes(c.status)) return true; } return false; } // eslint-disable-line no-await-in-loop
function ensureTimer() {
  if (timer || sandbox.isSandbox() || process.env.BROADCAST_TIMER === '0') return;
  timer = setInterval(async () => {
    try {
      const r = await tick();
      if (!r.sent && !(await hasActive())) { clearInterval(timer); timer = null; }
    } catch (e) { console.error('[broadcast] tick:', e.message); } // eslint-disable-line no-console
  }, 5000);
  if (timer.unref) timer.unref();
}
// at server start: ONLY continues campaigns a person started; on a database without any, nothing starts
async function resumeAtBoot() { try { if (await hasActive()) ensureTimer(); } catch { /* nothing to resume */ } }

// ---- counts + views ---------------------------------------------------------------------------
async function results(user, id, filters = {}) {
  const c = await getCamp(user, id);
  if (!c) return null;
  const rows = await S.get(rowsKey(id), []);
  const replies = await S.get(`bc.reply.${id}`, []);
  const by = { queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
  rows.forEach((x) => { by[x.st] = (by[x.st] || 0) + 1; });
  const left = by.sent + by.delivered + by.read + by.sending;
  const delivered = by.delivered + by.read;
  const latest = new Map();
  replies.forEach((x) => { latest.set(x.phone, x); });
  const ic = { interested: 0, not_interested: 0, optout: 0, question: 0 };
  latest.forEach((x) => { ic[x.intent] = (ic[x.intent] || 0) + 1; });
  const pct = (n) => (left ? Math.round((n * 100) / left) : 0);
  const planned = rows.filter((x) => x.st !== 'skipped').length;
  const done = planned - by.queued;
  const tiles = {
    sent: { n: by.sent + by.delivered + by.read, pct: 100 }, delivered: { n: delivered, pct: pct(delivered) }, read: { n: by.read, pct: pct(by.read) }, replied: { n: latest.size, pct: pct(latest.size) },
    interested: { n: ic.interested, pct: pct(ic.interested) }, not_interested: { n: ic.not_interested, pct: pct(ic.not_interested) }, optout: { n: ic.optout, pct: pct(ic.optout) }, failed: { n: by.failed, pct: pct(by.failed) },
  };
  const filtered = replies.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).filter((x) => (!filters.intent || x.intent === filters.intent)
    && (!filters.from || x.at >= filters.from) && (!filters.to || x.at <= `${filters.to}T23:59:59`));
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const mask = A.masked(user);
  const rowsOut = rows.filter((x) => !filters.status || x.st === filters.status || (filters.status === 'replied' && x.replied));
  return {
    campaign: { ...c, base: undefined }, planned, done, progress: planned ? Math.round((done * 100) / planned) : 0, by, tiles,
    skipped: Object.entries(rows.filter((x) => x.st === 'skipped').reduce((m, x) => { m[x.why] = (m[x.why] || 0) + 1; return m; }, {})).map(([why, n]) => ({ why, n })),
    replies: filtered.slice(0, 500).map((x) => ({ id: x.id, name: x.name, phone: mask ? core.maskMobile(x.phone) : `+${x.phone}`, text: x.text, at: x.at, intent: x.intent, intentWords: intent.WORDS[x.intent], added: x.added || null, candidateId: x.candidateId || null, autoReplied: !!x.autoReplied })),
    intentCounts: ic,
    rows: rowsOut.slice(0, 1000).map((x) => ({ i: x.i, name: x.name, phone: mask ? core.maskMobile(x.phone) : `+${x.phone}`, st: x.st, why: x.why, at: x.at, replied: !!x.replied, intent: x.intent })),
    timeline: timelineOf(c, rows, replies),
  };
}
function timelineOf(c, rows, replies) {
  const ev = [{ at: c.createdAt, text: `Created by ${c.createdByName}` }];
  if (c.startedAt) ev.push({ at: c.startedAt, text: `Started by ${c.startedByName}` });
  const sentAt = rows.map((r) => r.at).filter(Boolean).sort();
  if (sentAt.length) { ev.push({ at: sentAt[0], text: 'First message sent' }); ev.push({ at: sentAt[sentAt.length - 1], text: 'Latest message sent' }); }
  if (replies.length) ev.push({ at: replies.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0].at, text: 'First reply came in' });
  if (c.endedAt) ev.push({ at: c.endedAt, text: c.status === 'CANCELLED' ? 'Cancelled' : 'Finished' });
  return ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
async function listCampaigns(user, { jobId } = {}) {
  const out = [];
  for (const k of await S.keys('bc.camp.')) {
    const c = await S.get(k); // eslint-disable-line no-await-in-loop
    if (!c || (jobId && c.jobId !== jobId)) continue; // eslint-disable-line no-continue
    if (!(await getCamp(user, c.id))) continue; // eslint-disable-line no-await-in-loop
    const rows = await S.get(rowsKey(c.id), []); // eslint-disable-line no-await-in-loop
    const replies = await S.get(`bc.reply.${c.id}`, []); // eslint-disable-line no-await-in-loop
    const n = (st) => rows.filter((x) => st.includes(x.st)).length;
    out.push({ id: c.id, jobId: c.jobId, jobTitle: c.jobTitle, jobCode: c.jobCode, listName: c.listName, status: c.status, note: c.note, createdAt: c.createdAt, createdByName: c.createdByName, total: rows.length, sent: n(['sent', 'delivered', 'read']), queued: n(['queued', 'sending']), failed: n(['failed']), replies: new Set(replies.map((x) => x.phone)).size });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = { plan, create, start, pause, resume, cancel, tick, getCamp, results, listCampaigns, channelState, approvedTemplates, resumeAtBoot, ensureTimer, setRow, rowsKey, campKey, merge, applyLinkOf, baseOf, textFor, jobFor, eta, SKIP_WORDS, ACTIVE, transport, hasActive };
