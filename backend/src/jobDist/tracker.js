// ---------------------------------------------------------------------------
// THE POSTED TRACKER: what a person marked as posted by hand (DistPosting), when it expires, who must be reminded, and the
// "take it down" checklist when the job closes.
//
// HONEST WORDS: a post a person marked is shown as "Posted by <name> (not checked by the system)": TeamLink cannot see inside
// Naukri or WhatsApp. Only the automatic places (careers page, Telegram, Facebook ...) carry the system's own chips.
//
//   states   NOT_POSTED (no row) | POSTED | EXPIRING (expires within the reminder days) | EXPIRED | TAKEN_DOWN
//   markPosted / markTakenDown / undo        the three things a person does
//   sweep(now)                               expiry reminders (bell + My task) and the take-down checklist of closed jobs
//   onJobClosed(requirementId, user)         called when a job is closed
//   forRows / idsFor / counts                the Jobs list: "Posted on" chips, filter and counts, by-hand places included
//   tracker(user, f)                         the Posting tracker: where posted, pending, expired, per job and per platform
//   sources(ids)                             applicants per platform (counts only), from the tracked links
// Nothing here posts, deletes or contacts anything: it keeps records and reminds people.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { REQUIREMENT_LIVE_STATUSES } = require('../utils/atsVocab');
const {
  q, q1, ex, ms, iso, newId,
} = require('../jobPublish/db');
const Plat = require('./platforms');
const Attr = require('./attribution');

const DAY = 86400000;
const SETTINGS_KEY = 'jobdist.settings';
const marks = (ids) => ids.map(() => '?').join(',');
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// ---- settings (AppSetting) ------------------------------------------------------------------
const SETTING_DEFAULTS = { reminderDays: 3, closingNote: { telegram: false, facebook: false } };
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const days = Math.floor(Number(v.reminderDays));
  return {
    reminderDays: Number.isFinite(days) && days >= 1 && days <= 30 ? days : SETTING_DEFAULTS.reminderDays,
    closingNote: { telegram: !!(v.closingNote && v.closingNote.telegram), facebook: !!(v.closingNote && v.closingNote.facebook) },
  };
}
async function saveSettings(body, user) {
  const cur = await settings();
  const b = body || {};
  const next = { ...cur, closingNote: { ...cur.closingNote } };
  if (b.reminderDays !== undefined) {
    const n = Math.floor(Number(b.reminderDays));
    if (!Number.isFinite(n) || n < 1 || n > 30) return { error: 'Remind how many days before? Choose a number from 1 to 30.', status: 400 };
    next.reminderDays = n;
  }
  if (b.closingNote && typeof b.closingNote === 'object') {
    ['telegram', 'facebook'].forEach((k) => { if (b.closingNote[k] !== undefined) next.closingNote[k] = !!b.closingNote[k]; });
  }
  const v = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value: v, updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Job distribution settings changed', entity: 'JobDistribution', entityId: 'settings', toValue: v.slice(0, 300) });
  return { settings: next };
}

// ---- states ------------------------------------------------------------------------------------
// The state of one row at `now`. -> { key, label, tone, detail }
function stateOf(row, now = Date.now(), reminderDays = 3) {
  if (!row) return { key: 'NOT_POSTED', label: 'Not posted', tone: 'grey', detail: 'Nobody has marked this as posted yet.' };
  if (row.state === 'TAKEN_DOWN') return { key: 'TAKEN_DOWN', label: 'Taken down', tone: 'grey', detail: row.takedownDoneByName ? `Taken down by ${row.takedownDoneByName}.` : 'Taken down.' };
  const exp = ms(row.expiresAt);
  const by = row.postedByName || 'a team member';
  const when = ms(row.postedAt);
  const dateWords = when ? new Date(when).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const honest = `Posted by ${by} (not checked by the system)`;
  if (exp && exp <= now) return { key: 'EXPIRED', label: 'Expired', tone: 'red', detail: `${honest}${dateWords ? `, ${dateWords}` : ''}. The expiry date has passed: post it again or take it down.` };
  if (exp && exp - now <= reminderDays * DAY) {
    const left = Math.max(1, Math.ceil((exp - now) / DAY));
    return { key: 'EXPIRING', label: 'Expiring soon', tone: 'yellow', detail: `${honest}${dateWords ? `, ${dateWords}` : ''}. It expires in ${left} day${left === 1 ? '' : 's'}.` };
  }
  return { key: 'POSTED', label: honest, tone: 'green', detail: `${dateWords ? `Posted on ${dateWords}. ` : ''}${exp ? `Expires ${new Date(exp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'No expiry date.'}` };
}

const view = (r, now, days) => (r ? {
  id: r.id,
  requirementId: r.requirementId,
  platform: r.platform,
  state: stateOf(r, now, days),
  postUrl: r.postUrl || null,
  postedAt: iso(r.postedAt),
  postedById: r.postedById || null,
  postedByName: r.postedByName || null,
  expiresAt: iso(r.expiresAt),
  notes: r.notes || '',
  takedown: { state: r.takedownState || 'NONE', askedAt: iso(r.takedownAskedAt), doneAt: iso(r.takedownDoneAt), doneBy: r.takedownDoneByName || null, taskId: r.takedownTaskId || null },
  updatedAt: iso(r.updatedAt),
} : null);

const rowOf = (requirementId, platform) => q1('SELECT * FROM "DistPosting" WHERE "requirementId" = ? AND "platform" = ?', requirementId, platform);
const rowsOfJob = (requirementId) => q('SELECT * FROM "DistPosting" WHERE "requirementId" = ?', requirementId);

const audit = (user, action, requirementId, platform, detail) => logAudit({
  userId: user ? user.id : null, actorName: user ? user.name : 'TeamLink', action, entity: 'JobDistribution', entityId: requirementId,
  fromValue: platform ? platform.name : null, toValue: String(detail || '').slice(0, 400),
});

// ---- My tasks + bell (best effort: a reminder that cannot be written never blocks the person) ----------
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
async function openTask({ assignee, by, name, description, due }) {
  if (!assignee) return null;
  try {
    const t = await prisma.task.create({
      data: {
        name: String(name).slice(0, 190), department: null, description: String(description).slice(0, 1000), status: 'Not Started', priority: 'Medium',
        startDate: ymd(new Date()), endDate: ymd(due || new Date(Date.now() + 2 * DAY)),
        assigneeId: assignee.id, assignedById: (by && by.id) || assignee.id, assigneeName: assignee.name || 'Team member', assignedByName: (by && by.name) || 'TeamLink',
      },
    });
    return t.id;
  } catch { return null; }
}
async function closeTask(id) {
  if (!id) return;
  await prisma.task.updateMany({ where: { id, status: { in: ['Not Started', 'In Progress', 'On Hold'] } }, data: { status: 'Completed', completedAt: new Date() } }).catch(() => {});
}
async function bell(userIds, title, message) {
  try { await require('../utils/notify').notifyUsers([...new Set((userIds || []).filter(Boolean))], { title, message }); } catch { /* a bell is a bonus */ } // eslint-disable-line global-require
}
const userOf = (id) => (id ? prisma.user.findUnique({ where: { id }, select: { id: true, name: true, status: true } }).catch(() => null) : null);

// ---- the three things a person does ----------------------------------------------------------------
function parseUrl(v) {
  const s = clean(v, 500);
  if (!s) return { value: null };
  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return { error: 'The post link must start with http:// or https://' };
    return { value: u.toString() };
  } catch { return { error: 'The post link is not a valid web address. Copy it from the site after you post.' }; }
}

// body: { postUrl, postedAt, postedBy, expiresAt, noExpiry, notes, text }
async function markPosted(user, job, p, body) {
  if (p.kind === 'auto') return { error: `${p.name} is posted by TeamLink itself. There is nothing to mark.`, status: 400 };
  if (!p.active) return { error: `${p.name} is switched off in the list of places.`, status: 400 };
  if (job.internal && !['career', 'referral'].includes(p.key)) return { error: 'TeamLink internal hiring stays on our careers page and with our own team.', status: 400 };
  const b = body || {};
  const url = parseUrl(b.postUrl);
  if (url.error) return { error: url.error, status: 400 };
  const now = Date.now();
  let postedAt = now;
  if (b.postedAt) {
    postedAt = ms(b.postedAt);
    if (postedAt == null) return { error: 'The date you typed is not a date.', status: 400 };
    if (postedAt > now + DAY) return { error: 'The posting date is in the future. Choose today or an earlier day.', status: 400 };
  }
  let expiresAt = null;
  if (b.noExpiry) expiresAt = null;
  else if (b.expiresAt) {
    expiresAt = ms(b.expiresAt);
    if (expiresAt == null) return { error: 'The expiry date you typed is not a date.', status: 400 };
    if (expiresAt <= postedAt) return { error: 'The expiry date must come after the posting date.', status: 400 };
  } else if (p.expiryDays) expiresAt = postedAt + p.expiryDays * DAY;
  const postedByName = clean(b.postedBy, 80) || (user && user.name) || null;
  const notes = clean(b.notes, 500) || null;
  const prev = await rowOf(job.id, p.key);
  const id = prev ? prev.id : newId('dp');
  const kept = clean(b.text, 30000) || null;
  if (prev) {
    await ex(
      'UPDATE "DistPosting" SET "state"=\'POSTED\',"postUrl"=?,"postedAt"=?,"postedById"=?,"postedByName"=?,"expiresAt"=?,"notes"=?,"textOverride"=?,"reminderSentAt"=NULL,"expiryTaskId"=NULL,"takedownState"=\'NONE\',"takedownTaskId"=NULL,"takedownAskedAt"=NULL,"takedownDoneAt"=NULL,"takedownDoneByName"=NULL,"updatedAt"=? WHERE "id"=?',
      url.value, postedAt, user ? user.id : null, postedByName, expiresAt, notes, kept, now, id,
    );
    await closeTask(prev.expiryTaskId); await closeTask(prev.takedownTaskId);
  } else {
    await ex(
      'INSERT INTO "DistPosting" ("id","requirementId","platform","state","postUrl","postedAt","postedById","postedByName","expiresAt","notes","textOverride","takedownState","createdAt","updatedAt") VALUES (?,?,?,\'POSTED\',?,?,?,?,?,?,?,\'NONE\',?,?)',
      id, job.id, p.key, url.value, postedAt, user ? user.id : null, postedByName, expiresAt, notes, kept, now, now,
    );
  }
  await audit(user, prev ? 'Marked as posted again' : 'Marked as posted', job.id, p, `${postedByName}${url.value ? `, ${url.value}` : ''}${expiresAt ? `, expires ${ymd(expiresAt)}` : ''}`);
  const s = await settings();
  return { posting: view(await rowOf(job.id, p.key), now, s.reminderDays) };
}

async function markTakenDown(user, job, p) {
  const row = await rowOf(job.id, p.key);
  if (!row) return { error: `It is not marked as posted on ${p.name}, so there is nothing to take down.`, status: 404 };
  const now = Date.now();
  await ex('UPDATE "DistPosting" SET "state"=\'TAKEN_DOWN\',"takedownState"=\'DONE\',"takedownDoneAt"=?,"takedownDoneByName"=?,"updatedAt"=? WHERE "id"=?', now, user ? user.name : null, now, row.id);
  await closeTask(row.takedownTaskId); await closeTask(row.expiryTaskId);
  await audit(user, 'Taken down by hand', job.id, p, `${user ? user.name : ''} says it is removed from ${p.name}`);
  const s = await settings();
  return { posting: view(await rowOf(job.id, p.key), now, s.reminderDays) };
}

// "I marked the wrong place": the row goes away, so the place reads "Not posted" again.
async function undo(user, job, p) {
  const row = await rowOf(job.id, p.key);
  if (!row) return { ok: true };
  await ex('DELETE FROM "DistPosting" WHERE "id" = ?', row.id);
  await closeTask(row.takedownTaskId); await closeTask(row.expiryTaskId);
  await audit(user, 'Posted mark removed', job.id, p, 'Back to Not posted');
  return { ok: true };
}

// ---- reminders ---------------------------------------------------------------------------------------
async function assigneeFor(row, job) {
  for (const id of [row.postedById, job.tlId, job.bdeId, job.recruiterId]) {
    // eslint-disable-next-line no-await-in-loop
    const u = await userOf(id);
    if (u) return u;
  }
  return null;
}

async function ensureTakedown(row, job, p, now = Date.now()) {
  if (row.takedownState !== 'NONE' || row.state !== 'POSTED') return false;
  const who = await assigneeFor(row, job);
  const where = p.postUrl ? `Open ${p.name}: ${p.postUrl}` : `Remove it from ${p.name}.`;
  const taskId = await openTask({
    assignee: who, by: null, due: new Date(now + 2 * DAY),
    name: `Take it down: ${job.title} on ${p.name}`,
    description: `The requirement is closed. Take it off ${p.name}.\n${row.postUrl ? `Your post: ${row.postUrl}\n` : ''}${where}\nThen open the requirement, Distribute tab, and press "I took it down".`,
  });
  await ex('UPDATE "DistPosting" SET "takedownState"=\'ASKED\',"takedownTaskId"=?,"takedownAskedAt"=?,"updatedAt"=? WHERE "id"=? AND "takedownState"=\'NONE\'', taskId, now, now, row.id);
  await closeTask(row.expiryTaskId);
  await bell([who && who.id, job.tlId], `${job.title}: take it down from ${p.name}`, `The requirement is closed. Open the requirement, Distribute tab, and take it off ${p.name}${row.postUrl ? ` (${row.postUrl})` : ''}.`);
  return true;
}

// Closed jobs: one take-down checklist task per place where a person marked it posted.
async function takedownForJob(requirementId, now = Date.now()) {
  const job = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true, title: true, status: true, tlId: true, bdeId: true, recruiterId: true } });
  if (!job || job.status !== 'CLOSED') return 0;
  const rows = await q('SELECT * FROM "DistPosting" WHERE "requirementId" = ? AND "state" = \'POSTED\' AND "takedownState" = \'NONE\'', requirementId);
  let n = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const p = await Plat.get(row.platform);
    // eslint-disable-next-line no-await-in-loop
    if (p && await ensureTakedown(row, job, p, now)) n += 1;
  }
  return n;
}

// Called when a job is closed. Creates the checklist, and (only when an Admin switched "closing note" ON) queues one closing
// message to Telegram / Facebook for a job that was posted there. Nothing is ever deleted anywhere by this.
async function onJobClosed(requirementId, user = null) {
  const out = { tasks: 0, notes: 0 };
  try {
    if (!(await Plat.ready())) return out;
    out.tasks = await takedownForJob(requirementId);
    const s = await settings();
    for (const portal of ['telegram', 'facebook']) {
      if (!s.closingNote[portal]) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const pp = await q1('SELECT * FROM "PortalPosting" WHERE "requirementId" = ? AND "portal" = ? AND "status" = \'PUBLISHED\'', requirementId, portal);
      if (!pp) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line global-require
      const Q = require('../jobPublish/queue');
      // eslint-disable-next-line no-await-in-loop
      const e = await Q.enqueue({
        requirementId, portal, action: 'UNPUBLISH', payloadHash: `closing:${pp.portalJobId || ''}`, requestedBy: user ? user.id : null, requestedByName: user ? user.name : 'Job closed',
      });
      if (e.created) out.notes += 1;
    }
  } catch { /* closing a job never fails because of this */ }
  return out;
}

async function sweep(now = Date.now()) {
  const out = { reminded: 0, takedown: 0 };
  if (!(await Plat.ready())) return out;
  const s = await settings();
  const due = await q('SELECT * FROM "DistPosting" WHERE "state" = \'POSTED\' AND "expiresAt" IS NOT NULL AND "reminderSentAt" IS NULL AND "expiresAt" <= ?', now + s.reminderDays * DAY);
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const job = await prisma.requirement.findUnique({ where: { id: row.requirementId }, select: { id: true, title: true, status: true, tlId: true, bdeId: true, recruiterId: true } });
    // eslint-disable-next-line no-await-in-loop
    const p = await Plat.get(row.platform);
    if (!job || !p || job.status === 'CLOSED') continue; // eslint-disable-line no-continue
    const exp = ms(row.expiresAt);
    const gone = exp <= now;
    const left = Math.max(1, Math.ceil((exp - now) / DAY));
    // eslint-disable-next-line no-await-in-loop
    const who = await assigneeFor(row, job);
    const title = gone ? `${job.title}: the ${p.name} post has expired` : `${job.title}: the ${p.name} post expires in ${left} day${left === 1 ? '' : 's'}`;
    // eslint-disable-next-line no-await-in-loop
    const taskId = await openTask({
      assignee: who, by: null, due: new Date(Math.max(now, exp)), name: `Renew or take down: ${job.title} on ${p.name}`,
      description: `${gone ? 'The post has expired.' : `The post expires in ${left} day${left === 1 ? '' : 's'}.`} Post it again on ${p.name} if the requirement is still open, or take it down.${row.postUrl ? `\nYour post: ${row.postUrl}` : ''}${p.postUrl ? `\nOpen ${p.name}: ${p.postUrl}` : ''}`,
    });
    // eslint-disable-next-line no-await-in-loop
    await ex('UPDATE "DistPosting" SET "reminderSentAt"=?,"expiryTaskId"=?,"updatedAt"=? WHERE "id"=? AND "reminderSentAt" IS NULL', now, taskId, now, row.id);
    // eslint-disable-next-line no-await-in-loop
    await bell([row.postedById, job.tlId], title, 'Open the requirement, Distribute tab, to post it again or take it down.');
    out.reminded += 1;
  }
  const closed = await q('SELECT DISTINCT d."requirementId" rid FROM "DistPosting" d JOIN "Requirement" r ON r."id" = d."requirementId" WHERE d."state" = \'POSTED\' AND d."takedownState" = \'NONE\' AND r."status" = \'CLOSED\'');
  for (const c of closed) out.takedown += await takedownForJob(c.rid, now); // eslint-disable-line no-await-in-loop
  return out;
}
let sweptAt = 0;
async function maybeSweep() {
  if (Date.now() - sweptAt < 5 * 60 * 1000) return null;
  sweptAt = Date.now();
  return sweep().catch(() => null);
}

// ---- the Jobs list (the existing "Posted on" chips, filter and counts, by-hand places included) --------
const CHIP = { POSTED: ['posted', 'Posted by hand'], EXPIRING: ['expiring', 'Expiring soon'], EXPIRED: ['expired', 'Expired'] };
async function forRows(ids) {
  const out = new Map();
  if (!ids || !ids.length || !(await Plat.ready())) return out;
  const s = await settings();
  const now = Date.now();
  const names = new Map((await Plat.list({ all: true })).map((p) => [p.key, p.name]));
  const rows = await q(`SELECT * FROM "DistPosting" WHERE "requirementId" IN (${marks(ids)}) AND "state" = 'POSTED'`, ...ids);
  rows.forEach((r) => {
    const st = stateOf(r, now, s.reminderDays);
    const c = CHIP[st.key];
    if (!c) return;
    if (!out.has(r.requirementId)) out.set(r.requirementId, []);
    out.get(r.requirementId).push({
      portal: r.platform, name: names.get(r.platform) || r.platform, state: c[0], words: c[1], url: r.postUrl || null, byHand: true, by: r.postedByName || null,
    });
  });
  return out;
}
// The job ids that have a by-hand post that is still up (posted, expiring or expired are all "on the platform": a person must act).
async function liveIds(platform = null, { includeExpired = true } = {}) {
  if (!(await Plat.ready())) return [];
  const now = Date.now();
  const rows = await q(`SELECT DISTINCT "requirementId" rid FROM "DistPosting" WHERE "state" = 'POSTED'${platform ? ' AND "platform" = ?' : ''}${includeExpired ? '' : ' AND ("expiresAt" IS NULL OR "expiresAt" > ?)'}`, ...(platform ? [platform] : []), ...(includeExpired ? [] : [now]));
  return rows.map((r) => r.rid);
}
// { platform: Set(requirementId) } of the by-hand posts that are still up
async function countSets(scopeIds) {
  const out = {};
  if (!(await Plat.ready())) return out;
  const rows = await q('SELECT "platform", "requirementId" rid FROM "DistPosting" WHERE "state" = \'POSTED\'');
  const set = scopeIds ? new Set(scopeIds) : null;
  rows.forEach((r) => {
    if (set && !set.has(r.rid)) return;
    if (!out[r.platform]) out[r.platform] = new Set();
    out[r.platform].add(r.rid);
  });
  return out;
}
async function counts(scopeIds) {
  const sets = await countSets(scopeIds);
  return Object.fromEntries(Object.keys(sets).map((k) => [k, sets[k].size]));
}

// ---- applicants per platform (counts only) ----------------------------------------------------------------
// From the tracked links: Application.utmSource (the link's tag) or Application.firstSource (the board name).
async function sources(requirementIds) {
  const where = requirementIds ? { requirementId: { in: requirementIds } } : {};
  const rows = await prisma.application.findMany({ where, select: { requirementId: true, firstSource: true, utmSource: true } });
  const byJob = new Map(); const total = {};
  rows.forEach((a) => {
    const key = Attr.keyFor(a.utmSource) || Attr.keyFor(a.firstSource) || '_other';
    total[key] = (total[key] || 0) + 1;
    if (!byJob.has(a.requirementId)) byJob.set(a.requirementId, {});
    const o = byJob.get(a.requirementId); o[key] = (o[key] || 0) + 1;
  });
  return { total, byJob };
}

// ---- the Posting tracker ----------------------------------------------------------------------------------
// f: { status: posted|expiring|expired|taken_down|pending|'' , platform, q, limit }
async function tracker(user, f = {}, scopedIds = null) {
  if (!(await Plat.ready())) return { notReady: true, counts: {}, byPlatform: [], rows: [] };
  const s = await settings();
  const now = Date.now();
  const platforms = (await Plat.list()).filter((p) => p.kind !== 'auto');
  const pmap = new Map(platforms.map((p) => [p.key, p]));
  const scopeSet = scopedIds ? new Set(scopedIds) : null;
  const where = scopedIds ? (scopedIds.length ? { id: { in: scopedIds } } : { id: '__none__' }) : {};
  const live = await prisma.requirement.findMany({
    where: { ...where, status: { in: REQUIREMENT_LIVE_STATUSES }, internal: false }, select: { id: true, title: true, reqCode: true, status: true },
  });
  const all = await q('SELECT d.*, r."title" title, r."reqCode" reqCode, r."status" jobStatus FROM "DistPosting" d JOIN "Requirement" r ON r."id" = d."requirementId" ORDER BY d."updatedAt" DESC');
  const mine = all.filter((r) => (!scopeSet || scopeSet.has(r.requirementId)) && pmap.has(r.platform));
  // posted automatically through the job-publish engine (Naukri, Shine ... when an Admin switched automation on) counts as posted
  let engine = [];
  try {
    const keys = [...new Set(platforms.map((p) => p.engine).filter(Boolean))];
    if (keys.length) engine = await q(`SELECT "requirementId" rid, "portal" FROM "PortalPosting" WHERE "status" = 'PUBLISHED' AND "portal" IN (${marks(keys)})`, ...keys);
  } catch { engine = []; }
  const engineSet = new Set(engine.map((e) => `${e.rid}|${e.portal}`));
  const apps = await sources(scopedIds || null);
  const byPlatform = platforms.map((p) => ({
    key: p.key, name: p.name, kind: p.kind, posted: 0, expiring: 0, expired: 0, takenDown: 0, pending: 0, applicants: apps.total[p.key] || 0,
  }));
  const bp = new Map(byPlatform.map((x) => [x.key, x]));
  const rows = [];
  const have = new Set();
  mine.forEach((r) => {
    const st = stateOf(r, now, s.reminderDays);
    const x = bp.get(r.platform);
    have.add(`${r.requirementId}|${r.platform}`);
    if (st.key === 'POSTED') x.posted += 1; else if (st.key === 'EXPIRING') x.expiring += 1; else if (st.key === 'EXPIRED') x.expired += 1; else if (st.key === 'TAKEN_DOWN') x.takenDown += 1;
    rows.push({
      requirementId: r.requirementId, title: r.title, reqCode: r.reqCode || null, jobStatus: r.jobStatus, platform: r.platform, platformName: x.name, status: st.key.toLowerCase(), words: st.label, detail: st.detail, tone: st.tone,
      postUrl: r.postUrl || null, postedByName: r.postedByName || null, postedAt: iso(r.postedAt), expiresAt: iso(r.expiresAt), applicants: (apps.byJob.get(r.requirementId) || {})[r.platform] || 0,
    });
  });
  // pending: a live job that is not on this place yet
  const pendingRows = [];
  live.forEach((j) => {
    platforms.forEach((p) => {
      if (have.has(`${j.id}|${p.key}`) || (p.engine && engineSet.has(`${j.id}|${p.engine}`))) return;
      bp.get(p.key).pending += 1;
      if (f.status === 'pending') pendingRows.push({
        requirementId: j.id, title: j.title, reqCode: j.reqCode || null, jobStatus: j.status, platform: p.key, platformName: p.name, status: 'pending', words: 'Not posted yet', detail: 'This open requirement is not on this place yet.', tone: 'yellow', postUrl: null, postedByName: null, postedAt: null, expiresAt: null, applicants: 0,
      });
    });
  });
  const sum = (k) => byPlatform.reduce((n, x) => n + x[k], 0);
  // jobs (not job x place pairs) that are not posted anywhere yet
  const postedJobs = new Set([...have].map((k) => k.split('|')[0]).concat(engine.map((e) => e.rid)));
  const countsOut = {
    posted: sum('posted'), expiring: sum('expiring'), expired: sum('expired'), takenDown: sum('takenDown'), pending: sum('pending'), jobsNotPosted: live.filter((j) => !postedJobs.has(j.id)).length,
  };
  let list = f.status === 'pending' ? pendingRows : rows;
  if (f.status && f.status !== 'pending') {
    const want = String(f.status).replace('-', '_').toLowerCase();
    list = list.filter((r) => r.status === want);
  }
  if (f.platform) list = list.filter((r) => r.platform === f.platform);
  if (f.q) { const t = String(f.q).toLowerCase(); list = list.filter((r) => `${r.title} ${r.reqCode || ''}`.toLowerCase().includes(t)); }
  const limit = Math.min(1000, Math.max(1, Number(f.limit) || 500));
  return {
    counts: countsOut, byPlatform, rows: list.slice(0, limit), total: list.length, reminderDays: s.reminderDays, openJobs: live.length,
  };
}

module.exports = {
  settings, saveSettings, stateOf, view, rowOf, rowsOfJob, markPosted, markTakenDown, undo, sweep, maybeSweep, onJobClosed, takedownForJob,
  forRows, liveIds, counts, countSets, sources, tracker, DAY, SETTING_DEFAULTS,
};
