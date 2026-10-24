// ---------------------------------------------------------------------------
// SCHEDULED MESSAGES (Omni-Channel > Internal (HR) > Scheduled messages): birthday wishes, policy reminders, work anniversaries, custom.
// A RULE says: who (all active staff / a department / a staff Group), which staff template, when (a fixed date, every year on the birthday or the
// work anniversary, every week on a day, every month on a day), at what time (India time), by Email (WhatsApp / SMS: coming later), On or Off.
// Rules are saved as AppSetting 'outreach.scheduled.rules' (no new table). DEFAULT OFF: a new rule sends nothing until someone turns it On.
//
// ENGINE   an in-process tick (every minute, started with the sender loop, never in the sandbox) under the same DB lease pattern as the sender
//          ('scheduler' row of OutreachRunnerLease: one holder at a time). For every rule that is On and due today (India date) it makes ONE internal
//          campaign per rule + date (deterministic id, INSERT OR IGNORE) and one queue row per person with the idempotency key
//          sched:<rule>:<yyyy-mm-dd>:<contact>, so a repeated tick, a restart or two servers can never send twice. The rows then go through the
//          existing Internal path (runner.js): staff contacts only, no tracked link, no funnel event, the same opt-out rules, test mode, daily limit.
//   WAITS  Outreach sending OFF -> the tick does nothing (a birthday wish is not kept for days); quiet hours (when the Admin applied them to staff
//          messages) -> it waits for the end of quiet hours. A message is skipped, never sent late, when the server was off for 6 hours past the time.
//   WHO    internal contacts only (a job lead can never be in the audience). Birthday / anniversary need the person's Employee record (matched by email).
//   WHO MAY MANAGE  Admin and the HR desk / Internal HR (access.manageScheduled). The HR desk can turn a rule On only when an Admin allowed Internal HR to send.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Quiet = require('./quiet');
const Sup = require('./suppress');
const { logAudit } = require('../utils/audit');

const RULES_KEY = 'outreach.scheduled.rules';
const RUNS_KEY = 'outreach.scheduled.runs';
const KINDS = { birthday: 'Birthday wishes', anniversary: 'Work anniversary', policy: 'Policy reminder', custom: 'Custom message' };
const TRIGGERS = { fixed: 'On one date', birthday: 'Every year on the birthday', anniversary: 'Every year on the work anniversary', weekly: 'Every week', monthly: 'Every month' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ACTIVE_STAFF = ['Active', 'On Probation', 'Notice Period'];
const LATE_MS = 6 * 3600 * 1000;
const IST = Quiet.IST; const DAY = Quiet.DAY;
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ---- India dates --------------------------------------------------------------------------------
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10); // yyyy-mm-dd in India
const parts = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return { y, m, d }; };
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const atIst = (ymd, hm) => Date.parse(`${ymd}T${hm}:00+05:30`);
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// does this rule's trigger fire on this India date? (pure)  Feb 29 people are wished on Feb 28 in years without a 29th.
function triggerHits(rule, ymd) {
  const t = rule.trigger || {}; const { y, m, d } = parts(ymd);
  if (t.type === 'fixed') return t.date === ymd;
  if (t.type === 'weekly') return weekdayOf(ymd) === Number(t.weekday);
  if (t.type === 'monthly') return d === Math.min(Number(t.day), daysIn(y, m));
  return t.type === 'birthday' || t.type === 'anniversary'; // every day: the people are matched by date below
}
// is the month-day of a stored date today's (India)? Feb 29 -> Feb 28 in a normal year.
function sameMonthDay(stored, ymd) {
  if (!stored) return false;
  const x = new Date(new Date(stored).getTime() + IST);
  const sm = x.getUTCMonth() + 1; const sd = x.getUTCDate(); const { y, m, d } = parts(ymd);
  if (sm === m && sd === d) return true;
  return sm === 2 && sd === 29 && !isLeap(y) && m === 2 && d === 28;
}
// the moment this rule is due on that date, and whether `now` is inside [time, time + 6 hours]
function dueNow(rule, now) {
  const ymd = istDate(now);
  if (!triggerHits(rule, ymd) || !HM.test(String(rule.time || ''))) return { due: false, date: ymd };
  const at = atIst(ymd, rule.time);
  return { due: now >= at && now <= at + LATE_MS, date: ymd, at };
}
// the next few times a rule fires (for the "next run" preview)
function nextRuns(rule, now = Date.now(), n = 3) {
  const out = []; let day = istDate(now);
  for (let i = 0; i < 800 && out.length < n; i += 1) {
    if (triggerHits(rule, day) && HM.test(String(rule.time || ''))) { const at = atIst(day, rule.time); if (at >= now) out.push(new Date(at).toISOString()); }
    day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  }
  return out;
}

// ---- storage ---------------------------------------------------------------------------------------
async function loadRules() { const v = await S.getKey(RULES_KEY, []); return Array.isArray(v) ? v : []; }
const saveRules = (list, user) => S.putKey(RULES_KEY, list, user);
async function loadRuns() { const v = await S.getKey(RUNS_KEY, []); return Array.isArray(v) ? v : []; }
async function addRun(run) { const list = await loadRuns(); list.unshift({ ...run, at: new Date(run.at || Date.now()).toISOString() }); await S.putKey(RUNS_KEY, list.slice(0, 300)); }

// ---- the rule -------------------------------------------------------------------------------------------
function clean(b, cur = {}) {
  const kind = KINDS[b.kind !== undefined ? b.kind : cur.kind] ? (b.kind !== undefined ? b.kind : cur.kind) : null;
  if (!kind) return { error: 'Pick what this message is: Birthday, Work anniversary, Policy reminder or Custom.' };
  const name = S.clip(b.name !== undefined ? b.name : cur.name, 80);
  if (name.length < 2) return { error: 'Give the rule a name.' };
  const tin = b.trigger !== undefined ? b.trigger : cur.trigger;
  const t = tin && typeof tin === 'object' ? tin : {};
  let type = TRIGGERS[t.type] ? t.type : null;
  if (kind === 'birthday') type = 'birthday'; else if (kind === 'anniversary') type = 'anniversary'; else if (!type || type === 'birthday' || type === 'anniversary') type = type || 'fixed';
  const trigger = { type };
  if (type === 'fixed') { if (!validDate(t.date)) return { error: 'Pick the date this message goes out.' }; trigger.date = t.date; }
  if (type === 'weekly') { const w = Math.floor(Number(t.weekday)); if (!(w >= 0 && w <= 6)) return { error: 'Pick the day of the week.' }; trigger.weekday = w; }
  if (type === 'monthly') { const d = Math.floor(Number(t.day)); if (!(d >= 1 && d <= 31)) return { error: 'Pick the day of the month (1 to 31).' }; trigger.day = d; }
  const time = b.time !== undefined ? String(b.time) : (cur.time || '09:00');
  if (!HM.test(time)) return { error: 'The send time must look like 09:30 (India time).' };
  const ain = b.audience !== undefined ? b.audience : cur.audience;
  const a = ain && typeof ain === 'object' ? ain : { type: 'all' };
  const audience = { type: ['all', 'department', 'group'].includes(a.type) ? a.type : 'all' };
  if (audience.type === 'department') { audience.department = S.clip(a.department, 80); if (!audience.department) return { error: 'Pick the department.' }; }
  if (audience.type === 'group') { audience.segmentId = S.clip(a.segmentId, 60); if (!audience.segmentId) return { error: 'Pick the staff group.' }; }
  const channel = String(b.channel !== undefined ? b.channel : (cur.channel || 'email'));
  if (channel !== 'email') return { error: 'WhatsApp and SMS are coming later. For now, pick Email.' };
  const templateId = S.clip(b.templateId !== undefined ? b.templateId : cur.templateId, 60);
  if (!templateId) return { error: 'Pick the message to send.' };
  return { rule: { name, kind, trigger, time, audience, templateId, channel } };
}
async function templateOk(templateId) {
  if (!(await S.ready())) return { error: 'Messages are being set up, so a message cannot be picked yet. Please try again in a little while.' };
  const tr = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', templateId))[0];
  if (!tr || tr.status !== 'active') return { error: 'This message template was not found.' };
  if (tr.audience !== 'internal') return { error: 'Pick a staff template (an internal one).' };
  if (tr.channel !== 'email') return { error: 'Pick an email message for now.' };
  return { template: tr };
}
async function audienceOk(a) {
  if (a.type === 'group') {
    const seg = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ? AND deletedAt IS NULL', a.segmentId))[0];
    if (!seg) return { error: 'The staff group was not found.' };
    if (seg.contactType !== 'internal') return { error: 'This group is not a staff group. Candidate contacts can never get staff messages.' };
  }
  return {};
}

// ---- who (internal contacts only) ------------------------------------------------------------------------------
async function employeesByEmail() {
  const rows = await prisma.employee.findMany({ select: { email: true, department: true, employmentStatus: true, dateOfBirth: true, dateOfJoining: true } }).catch(() => []);
  const m = new Map();
  rows.forEach((e) => { if (e.email) m.set(String(e.email).trim().toLowerCase(), e); });
  return m;
}
// -> { ids: [contactId], reasons } for this rule on this India date
async function people(rule, ymd) {
  let ids = [];
  const a = rule.audience || { type: 'all' };
  if (a.type === 'group') ids = (await Sup.members([a.segmentId], 'internal')).ids;
  else ids = (await S.q("SELECT id FROM \"OutreachContact\" WHERE contactType = 'internal' AND status = 'active'")).map((r) => r.id);
  if (!ids.length) return { ids: [] };
  const emps = await employeesByEmail();
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = await S.q(`SELECT id, emailKey, department FROM "OutreachContact" WHERE id IN (${part.map(() => '?').join(',')}) AND contactType = 'internal' AND status = 'active'`, ...part); // eslint-disable-line no-await-in-loop
    rows.forEach((c) => {
      const e = c.emailKey ? emps.get(String(c.emailKey).toLowerCase()) : null;
      if (e && !ACTIVE_STAFF.includes(e.employmentStatus)) return; // relieved / exited: not "active staff"
      if (a.type === 'department') { const dep = String((e && e.department) || c.department || '').toLowerCase(); if (dep !== String(a.department).toLowerCase()) return; }
      if (rule.trigger.type === 'birthday') { if (!e || !sameMonthDay(e.dateOfBirth, ymd)) return; }
      if (rule.trigger.type === 'anniversary') { if (!e || !e.dateOfJoining || !sameMonthDay(e.dateOfJoining, ymd) || Number(ymd.slice(0, 4)) <= new Date(new Date(e.dateOfJoining).getTime() + IST).getUTCFullYear()) return; }
      out.push(c.id);
    });
  }
  return { ids: out };
}

// ---- running one rule on one date (idempotent) -----------------------------------------------------------------------------
const campaignIdOf = (ruleId, ymd) => `osch_${String(ruleId).replace(/[^a-zA-Z0-9]/g, '')}_${ymd.replace(/-/g, '')}`;
async function runRule(rule, { now = Date.now(), st = null, date = null } = {}) {
  const settings = st || await S.settings();
  const ymd = date || istDate(now);
  const tr = await templateOk(rule.templateId);
  if (tr.error) { await addRun({ at: now, ruleId: rule.id, ruleName: rule.name, date: ymd, status: 'problem', note: tr.error, people: 0, queued: 0, skipped: 0 }); return { status: 'problem', note: tr.error }; }
  const who = await people(rule, ymd);
  if (!who.ids.length) return { status: 'nobody', people: 0 };
  const cid = campaignIdOf(rule.id, ymd);
  const snapshot = { name: tr.template.name, subject: tr.template.subject || '', body: tr.template.body };
  let code = '';
  for (let i = 0; i < 5; i += 1) { code = crypto.randomBytes(6).toString('base64url'); if (!(await S.q('SELECT 1 x FROM "OutreachCampaign" WHERE code = ?', code)).length) break; } // eslint-disable-line no-await-in-loop
  const mode = settings.emailTestMode ? 'rehearsal' : 'live';
  await S.run(`INSERT OR IGNORE INTO "OutreachCampaign" (id, code, name, type, requirementId, segmentIds, channel, templateId, templateSnapshot, status, mode, startedAt, suppressDays, createdById, createdByName, createdAt, updatedAt)
    VALUES (?,?,?,'internal',NULL,'[]','email',?,?,'running',?,?,?,?,?,?,?)`, cid, code, `${S.clip(rule.name, 60)} (${ymd})`, rule.templateId, JSON.stringify(snapshot), mode, now, settings.suppressDays, rule.createdById || null, 'Scheduled message', now, now);
  const camp = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', cid))[0];
  const res = await Sup.evaluate(camp, who.ids, { days: settings.suppressDays, now });
  let queued = 0; let skipped = 0; let fresh = 0; const reasons = {};
  for (const r of res) {
    const key = `sched:${rule.id}:${ymd}:${r.contactId}`;
    const exists = (await S.q('SELECT id, status, reason FROM "OutreachMessage" WHERE campaignId = ? AND contactId = ?', cid, r.contactId))[0]; // eslint-disable-line no-await-in-loop
    if (exists) { if (exists.status === 'skipped') { skipped += 1; reasons[exists.reason] = 1 + (reasons[exists.reason] || 0); } else queued += 1; continue; } // eslint-disable-line no-continue
    const mid = S.newId('om');
    if (r.decision.send) {
      const did = await S.run('INSERT OR IGNORE INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, token, idempotencyKey, nextRunAt, queuedAt) VALUES (?,?,?,\'email\',NULL,\'queued\',NULL,?,?,?)', mid, cid, r.contactId, key, now, now); // eslint-disable-line no-await-in-loop
      fresh += did ? 1 : 0; queued += 1;
    } else {
      const did = await S.run('INSERT OR IGNORE INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, reason, idempotencyKey, nextRunAt, queuedAt) VALUES (?,?,?,\'email\',NULL,\'skipped\',?,?,0,?)', mid, cid, r.contactId, r.decision.reason, key, now); // eslint-disable-line no-await-in-loop
      fresh += did ? 1 : 0; skipped += 1; reasons[r.decision.reason] = 1 + (reasons[r.decision.reason] || 0);
    }
  }
  if (fresh > 0) await S.run("UPDATE \"OutreachCampaign\" SET status = 'running', completedAt = NULL, updatedAt = ? WHERE id = ? AND status = 'done'", now, cid);
  if (fresh > 0) await addRun({ at: now, ruleId: rule.id, ruleName: rule.name, date: ymd, campaignId: cid, status: 'queued', mode, people: who.ids.length, queued, skipped, reasons, note: mode === 'rehearsal' ? 'Test mode is ON: a rehearsal, nothing is really sent.' : '' });
  return { status: fresh > 0 ? 'queued' : 'already', people: who.ids.length, queued, skipped, fresh, campaignId: cid };
}

// ---- the lease + one pass ----------------------------------------------------------------------------------------------------
const HOLDER = `sched:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
async function acquire(holder, now, ttl = 55000) {
  await S.run('INSERT INTO "OutreachRunnerLease" (name, holder, expiresAt) VALUES (\'scheduler\', ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expiresAt = excluded.expiresAt WHERE "OutreachRunnerLease".expiresAt < ? OR "OutreachRunnerLease".holder = ?', holder, now + ttl, now, holder);
  const r = (await S.q('SELECT holder FROM "OutreachRunnerLease" WHERE name = \'scheduler\''))[0];
  return !!r && r.holder === holder;
}
// opts: { now, holder (a test passes its own), noLease }
async function tick(opts = {}) {
  const now = opts.now || Date.now();
  const out = { skipped: null, ran: [] };
  if (!(await S.campaignsReady())) { out.skipped = 'not_ready'; return out; }
  const st = await S.settings();
  if (!st.master) { out.skipped = 'sending_off'; return out; }
  const rules = (await loadRules()).filter((r) => r.enabled === true);
  if (!rules.length) { out.skipped = 'no_rules'; return out; }
  if (!opts.noLease && !(await acquire(opts.holder || HOLDER, now))) { out.skipped = 'other_server'; return out; }
  for (const rule of rules) {
    const d = dueNow(rule, now);
    if (!d.due) continue; // eslint-disable-line no-continue
    if (Quiet.state(now, st.quietHours, 'internal').active) { out.ran.push({ ruleId: rule.id, status: 'waiting_quiet' }); continue; } // eslint-disable-line no-continue
    try { const r = await runRule(rule, { now, st, date: d.date }); out.ran.push({ ruleId: rule.id, ...r }); } catch (e) { out.ran.push({ ruleId: rule.id, status: 'error', note: S.clip(e && e.message, 120) }); } // eslint-disable-line no-await-in-loop
  }
  return out;
}

let timer = null; let busy = false;
async function loop() {
  if (busy) return; busy = true;
  try { await tick({}); } catch (e) { console.error('[outreach] scheduled messages:', e && e.message); } finally { busy = false; } // eslint-disable-line no-console
}
function ensureTimer() {
  if (timer) return;
  if (require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(loop, 60000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// ---- what the screens see ------------------------------------------------------------------------------------------------------
function audienceWords(a, segName) {
  if (!a || a.type === 'all') return 'All active staff';
  if (a.type === 'department') return `Department: ${a.department}`;
  return `Staff group: ${segName || 'a group'}`;
}
function whenWords(rule) {
  const t = rule.trigger; const at = `at ${rule.time} (India time)`;
  if (t.type === 'fixed') return `On ${t.date} ${at}`;
  if (t.type === 'birthday') return `Every year on each person's birthday ${at}`;
  if (t.type === 'anniversary') return `Every year on each person's work anniversary ${at}`;
  if (t.type === 'weekly') return `Every ${WEEKDAYS[t.weekday]} ${at}`;
  return `Every month on day ${t.day} ${at}`;
}
async function viewRule(r, now, ctx) {
  const next = nextRuns(r, now, 3);
  let status = { key: 'off', words: 'Off: nothing is sent.' };
  if (r.enabled) {
    if (!ctx.ready) status = { key: 'waiting', words: 'On, but messages are being set up, so nothing goes out yet.' };
    else if (!ctx.st.master) status = { key: 'waiting', words: 'On, but Outreach sending is switched OFF, so nothing goes out.' };
    else if (ctx.st.emailTestMode) status = { key: 'rehearsal', words: 'On, in test mode: it is rehearsed and nobody is emailed.' };
    else status = { key: 'on', words: 'On: it goes out by itself.' };
  }
  let todayPeople = null;
  if (ctx.ready && ['birthday', 'anniversary'].includes(r.trigger.type)) { try { todayPeople = (await people(r, istDate(now))).ids.length; } catch { todayPeople = null; } }
  return { ...r, kindWords: KINDS[r.kind], whenWords: whenWords(r), audienceWords: audienceWords(r.audience, ctx.segs[r.audience && r.audience.segmentId]), templateName: ctx.tpls[r.templateId] || '(removed)', nextRuns: next, status, todayPeople };
}
async function list(user) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const now = Date.now();
  const ready = await S.campaignsReady();
  const st = await S.settings();
  const rules = await loadRules();
  const tplRows = (await S.ready()) ? await S.q("SELECT id, name FROM \"OutreachTemplate\" WHERE audience = 'internal'") : [];
  const segRows = (await S.ready()) ? await S.q("SELECT id, name FROM \"OutreachSegment\" WHERE contactType = 'internal' AND deletedAt IS NULL") : [];
  const ctx = { ready, st, tpls: Object.fromEntries(tplRows.map((t) => [t.id, t.name])), segs: Object.fromEntries(segRows.map((t) => [t.id, t.name])) };
  const views = [];
  for (const r of rules) views.push(await viewRule(r, now, ctx)); // eslint-disable-line no-await-in-loop
  return { ready, sendingOn: st.master, testMode: st.emailTestMode, quiet: Quiet.describe(st.quietHours), rules: views };
}
async function options(user) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const ok = await S.ready();
  const templates = ok ? (await S.q("SELECT id, name, channel FROM \"OutreachTemplate\" WHERE audience = 'internal' AND status = 'active' AND channel = 'email' ORDER BY name")) : [];
  const groups = ok ? (await S.q("SELECT id, name FROM \"OutreachSegment\" WHERE contactType = 'internal' AND deletedAt IS NULL ORDER BY name")) : [];
  let departments = [];
  try { departments = (await prisma.employee.findMany({ where: { department: { not: null } }, select: { department: true }, distinct: ['department'], orderBy: { department: 'asc' } })).map((d) => d.department).filter(Boolean); } catch { departments = []; }
  return { templates, groups, departments, kinds: Object.entries(KINDS).map(([id, words]) => ({ id, words })), weekdays: WEEKDAYS };
}

async function create(user, b) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const c = clean(b || {});
  if (c.error) return { error: c.error, status: 400 };
  const t = await templateOk(c.rule.templateId); if (t.error) return { error: t.error, status: 400 };
  const g = await audienceOk(c.rule.audience); if (g.error) return { error: g.error, status: 400 };
  const rules = await loadRules();
  if (rules.length >= 60) return { error: 'There are already 60 rules. Delete one you do not use.', status: 400 };
  const now = Date.now();
  const rule = { id: S.newId('sr'), ...c.rule, enabled: false, createdById: user.id, createdByName: user.name, createdAt: now, updatedAt: now };
  rules.push(rule);
  await saveRules(rules, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach scheduled message created (Off)', entity: 'OutreachScheduled', entityId: rule.id, toValue: `${rule.kind}: ${S.clip(rule.name, 60)}` });
  return { rule };
}
async function update(user, id, b) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const rules = await loadRules();
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return { error: 'This rule was not found.', status: 404 };
  const c = clean(b || {}, rules[i]);
  if (c.error) return { error: c.error, status: 400 };
  const t = await templateOk(c.rule.templateId); if (t.error) return { error: t.error, status: 400 };
  const g = await audienceOk(c.rule.audience); if (g.error) return { error: g.error, status: 400 };
  rules[i] = { ...rules[i], ...c.rule, updatedAt: Date.now() };
  await saveRules(rules, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach scheduled message changed', entity: 'OutreachScheduled', entityId: id, toValue: S.clip(rules[i].name, 60) });
  return { rule: rules[i] };
}
async function toggle(user, id, on) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const rules = await loadRules();
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) return { error: 'This rule was not found.', status: 404 };
  if (on) {
    if (!(await S.campaignsReady())) return { error: 'Messages are being set up, so a rule cannot be switched On yet.', status: 503 };
    const st = await S.settings();
    if (A.kind(user) === 'hr' && !st.internalHrMaySend) return { error: 'An Admin has not allowed the HR desk to send. Ask an Admin to tick "Internal HR may send".', status: 403 };
    const t = await templateOk(rules[i].templateId); if (t.error) return { error: t.error, status: 400 };
  }
  rules[i] = { ...rules[i], enabled: !!on, updatedAt: Date.now() };
  await saveRules(rules, user);
  await logAudit({ userId: user.id, actorName: user.name, action: on ? 'Outreach scheduled message switched ON' : 'Outreach scheduled message switched OFF', entity: 'OutreachScheduled', entityId: id, toValue: S.clip(rules[i].name, 60) });
  return { rule: rules[i] };
}
async function remove(user, id) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const rules = await loadRules();
  const r = rules.find((x) => x.id === id);
  if (!r) return { error: 'This rule was not found.', status: 404 };
  await saveRules(rules.filter((x) => x.id !== id), user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach scheduled message deleted', entity: 'OutreachScheduled', entityId: id, toValue: S.clip(r.name, 60) });
  return { ok: true };
}
async function runs(user, id) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const list2 = (await loadRuns()).filter((r) => r.ruleId === id).slice(0, 50);
  return { runs: list2 };
}
// "Send a test to me": the same words, to the signed-in person's OWN address only (Campaigns.testSend does the sending: it never targets a contact)
async function testToMe(user, id, opts = {}) {
  if (!A.manageScheduled(user)) return { error: 'Scheduled messages are managed by the HR desk and Admins.', status: 403 };
  const r = (await loadRules()).find((x) => x.id === id);
  if (!r) return { error: 'This rule was not found.', status: 404 };
  if (!(await S.campaignsReady())) return { error: 'Messages are being set up, so a test cannot go out yet.', status: 503 };
  const Camp = require('./campaigns'); // eslint-disable-line global-require
  return Camp.testSend(user, { type: 'internal', templateId: r.templateId, segmentIds: [] }, opts);
}

module.exports = {
  KINDS, TRIGGERS, WEEKDAYS, istDate, triggerHits, sameMonthDay, dueNow, nextRuns, clean, people, runRule, tick, ensureTimer, stop, list, options, create, update, toggle, remove, runs, testToMe, loadRules, loadRuns, campaignIdOf, LATE_MS,
};
