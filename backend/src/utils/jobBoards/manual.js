// ---------------------------------------------------------------------------
// POST BY HAND — the honest route for a board that has no open posting API
// (Naukri, Shine, LinkedIn, and Indeed until its partner approval comes).
// (user, 2026-10-09: "Naukri, Indeed, Shine, LinkedIn ... post avvali ante em
// cheyyali?")
//
// What TeamLink does here, and does NOT do:
//   * It prepares the job in that board's order of fields, ready to copy, and
//     opens the board's own "post a job" page. A PERSON pastes it there.
//   * It never logs in to the board, never drives a browser, never scrapes
//     (all of that breaks the boards' terms). Nothing is sent to the board.
//   * The poster presses "I posted it" (optionally with the live link). The
//     row then reads "Posted by hand" with who / when / link — it is NEVER
//     shown as "Posted" (that word is kept for a board's own confirmation).
//   * If nobody does it within N hours (Setting posting.handReminderHours,
//     default 6) the job's TL / recruiters get a reminder (sweep below), and
//     the job page says how long it has been waiting.
//   * When the job is closed / paused / unticked, a hand-posted job becomes
//     "Take it down by hand" until a person presses "I took it down".
//
// Stored in RequirementPosting (no new column):
//   status  'Posted by hand' | 'Take down by hand'
//   externalUrl  the live link the poster pasted (optional)
//   postedAt     when it was marked posted
//   errorMessage the plain sentence "Posted by hand by <name>" (never an error)
// plus one audit row per action (entity RequirementPosting, fromValue = board).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const { logAudit } = require('../audit');
const { PUBLIC_COMPANY, csv } = require('./common');
const guide = require('./guide');

const ENTITY = 'RequirementPosting';
const HAND_DONE = 'Posted by hand';
const HAND_REMOVE = 'Take down by hand';
const REMINDER_KEY = 'posting.handReminderHours';
const DEFAULT_HOURS = 6;
const REMIND_PREFIX = 'posting.handReminded.';

const clean = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const dash = (v) => { const t = clean(v); return t && t !== '—' ? t : ''; };

// The link a candidate uses to apply — tagged with the board, so applicants
// from it arrive with Source = that board (routes/careersPublic.js ?src=).
function applyLink(r, board, base) {
  const slug = require('../jobSlug'); // eslint-disable-line global-require
  const path = slug.careersPath(r, guide.GUIDE[board].source);
  const root = String(base || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return root ? `${root}${path}` : path;
}

// The job, in the order that board's own form asks for it.
// Returns [{ key, label, value }] — each one has a Copy button, and the whole
// thing is one Copy-all text block.
// ov = what "Write the job posts" wrote for this board ({ description, title, skills }), or the
// poster's own saved version of it. Without it the job's own fields are used, minus internal notes.
function fields(r, board, base, ov = {}) {
  const g = guide.GUIDE[board];
  const skills = csv(ov.skills || r.skills);
  const own = [
    require('../jobPostWriter').publishable(clean(r.jobDescription) || clean(r.description)).text, // eslint-disable-line global-require
    clean(r.responsibilities) ? `Responsibilities:\n${clean(r.responsibilities)}` : '',
    clean(r.qualifications) ? `Requirements:\n${clean(r.qualifications)}` : '',
    csv(r.goodToHaveSkills).length ? `Good to have: ${csv(r.goodToHaveSkills).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
  const desc = clean(ov.description) || own;
  const all = {
    title: ['Job title', clean(ov.title) || clean(r.title)],
    company: ['Company name to show', PUBLIC_COMPANY],
    type: ['Employment type', clean(r.employmentType)],
    mode: ['Work mode', clean(r.workMode)],
    location: ['Job location', clean(r.location)],
    experience: ['Experience (years)', dash(r.experience) ? `${dash(r.experience)}${/year|yr/i.test(r.experience) ? '' : ' years'}` : ''],
    salary: ['Salary', dash(r.salary)],
    skills: [g.skillsLabel || 'Key skills', skills.join(', ')],
    education: ['Education', dash(r.education)],
    openings: ['Number of openings', r.openings ? String(r.openings) : ''],
    description: ['Job description', desc || clean(r.title)],
    apply: ['Apply link (if the board asks)', applyLink(r, board, base)],
    code: ['Our job ID (for your own tracking)', clean(r.reqCode) || r.id],
  };
  return g.order.map((k) => ({ key: k, label: all[k][0], value: all[k][1] })).filter((f) => f.value);
}

function textBlock(r, board, base, ov) {
  return fields(r, board, base, ov).map((f) => (f.key === 'description' ? `${f.label}:\n${f.value}` : `${f.label}: ${f.value}`)).join('\n\n');
}

// ---- who / when -------------------------------------------------------------
async function reminderHours() {
  const row = await prisma.appSetting.findUnique({ where: { key: REMINDER_KEY } }).catch(() => null);
  const n = row ? Number(JSON.parse(row.value || '{}').hours ?? row.value) : NaN;
  return n > 0 && n <= 240 ? n : DEFAULT_HOURS;
}

const niceWhen = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The link must be a web address on that board (or empty).
function checkLink(board, raw) {
  const url = clean(raw);
  if (!url) return { ok: true, url: null };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'That is not a web link. Copy the full link from the address bar (it starts with https://).' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'The link must start with https://' };
  const g = guide.GUIDE[board];
  const host = u.hostname.toLowerCase();
  if (!g.domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { ok: false, error: `That does not look like a ${g.name} link (it should be on ${g.domains[0]}). Copy the link of the live job from ${g.name}.` };
  }
  return { ok: true, url: u.toString().slice(0, 500) };
}

async function rowOf(rid, board) {
  return prisma.requirementPosting.findUnique({ where: { requirementId_source: { requirementId: rid, source: board } } }).catch(() => null);
}

// The text "Write the job posts" has for this board: the poster's saved version when there is one,
// else what TeamLink writes from the job (client name hidden, internal notes left out).
async function writtenFor(r, board, base) {
  const W = require('../jobPostWriter'); // eslint-disable-line global-require
  const ov = {};
  let missing = [];
  try {
    const jt = require('../jobText'); // eslint-disable-line global-require
    const full = await prisma.requirement.findUnique({ where: { id: r.id }, include: { client: true } });
    const gen = await jt.generate(full, {}, base);
    missing = (gen.missing || []).filter((m) => !m.optional).map((m) => m.label);
    const b = gen.boards[board];
    if (b) {
      ov.description = b.text;
      if (b.title) ov.title = b.title; // never the raw title: it may carry the client's name
      if (board === 'naukri') ov.skills = (b.tags || []).join(', ');
    }
  } catch { /* the job's own fields are used */ }
  let saved = null;
  const row = await W.loadSaved(r.id).catch(() => null);
  const mine = await W.savedBoardText(r.id, board).catch(() => null);
  if (mine && (mine.text || mine.title || mine.tags)) {
    if (mine.text) ov.description = mine.text;
    if (mine.title) ov.title = mine.title;
    if (mine.tags) ov.skills = mine.tags;
    const k = (row && row.keys && (row.keys[board] || row.keys[`${board}Title`] || row.keys.naukriTags)) || {};
    saved = { by: k.byName || (row && row.byName) || null, at: k.at || (row && row.savedAt) || null };
  }
  return { ov, saved, missing };
}

// What the helper shows for one job + board.
async function helper(r, board, base) {
  const g = guide.GUIDE[board];
  const { ov, saved, missing } = await writtenFor(r, board, base);
  const row = await rowOf(r.id, board);
  const hours = await reminderHours();
  const done = row && row.status === HAND_DONE;
  const remove = row && row.status === HAND_REMOVE;
  const since = !done && !remove ? (row ? row.createdAt : null) : null;
  const waitedHours = since ? Math.floor((Date.now() - new Date(since).getTime()) / 3600000) : 0;
  return {
    board, name: g.name,
    state: remove ? 'remove' : done ? 'done' : 'todo',
    title: `Post "${r.title}" on ${g.name} by hand`,
    openUrl: g.openUrl,
    openLabel: `Open ${g.name} — post a job`,
    steps: g.handSteps,
    fields: fields(r, board, base, ov),
    text: textBlock(r, board, base, ov),
    // The "[ ]" gaps the text still has (a fact the job does not carry yet) and what they are.
    gapMarks: (textBlock(r, board, base, ov).match(/[s*]/g) || []).length,
    gaps: (textBlock(r, board, base, ov).match(/[s*]/g) || []).length ? missing : [],
    usesSaved: !!saved,
    saved,
    applyLink: applyLink(r, board, base),
    note: g.handNote || null,
    link: done || remove ? row.externalUrl || null : null,
    doneAt: done || remove ? row.postedAt || null : null,
    doneText: done || remove ? row.errorMessage || null : null,
    reminderHours: hours,
    waitedHours,
    overdue: !done && !remove && waitedHours >= hours,
  };
}

async function markDone(r, board, user, rawUrl) {
  const chk = checkLink(board, rawUrl);
  if (!chk.ok) return { error: chk.error, status: 400 };
  const g = guide.GUIDE[board];
  const prev = await rowOf(r.id, board);
  const data = {
    status: HAND_DONE,
    externalUrl: chk.url,
    postedAt: new Date(),
    removedAt: null,
    errorMessage: `Posted by hand by ${user.name || 'a team member'}`,
    attempts: (prev ? prev.attempts || 0 : 0) + 1,
    lastTriedAt: new Date(),
  };
  await prisma.requirementPosting.upsert({
    where: { requirementId_source: { requirementId: r.id, source: board } },
    create: { requirementId: r.id, source: board, ...data },
    update: data,
  });
  await logAudit({
    userId: user.id, actorName: user.name, action: 'Posted by hand', entity: ENTITY, entityId: r.id, fromValue: g.name,
    toValue: chk.url ? `Live link ${chk.url}` : 'No link saved',
  }).catch(() => {});
  return { ok: true };
}

async function markRemoved(r, board, user) {
  const g = guide.GUIDE[board];
  const prev = await rowOf(r.id, board);
  if (!prev || ![HAND_DONE, HAND_REMOVE].includes(prev.status)) return { error: `This job was not posted by hand on ${g.name}.`, status: 409 };
  await prisma.requirementPosting.update({
    where: { requirementId_source: { requirementId: r.id, source: board } },
    data: { status: 'Removed', removedAt: new Date(), errorMessage: null, lastTriedAt: new Date() },
  });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Taken down by hand', entity: ENTITY, entityId: r.id, fromValue: g.name, toValue: 'Removed' }).catch(() => {});
  return { ok: true };
}

// "I did not post it after all" — the row goes away; the board shows its
// normal state again.
async function markUndone(r, board, user) {
  const g = guide.GUIDE[board];
  const prev = await rowOf(r.id, board);
  if (!prev || prev.status !== HAND_DONE) return { error: `Nothing to undo for ${g.name}.`, status: 409 };
  await prisma.requirementPosting.delete({ where: { requirementId_source: { requirementId: r.id, source: board } } });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Posted by hand — undone', entity: ENTITY, entityId: r.id, fromValue: g.name, toValue: 'Not posted' }).catch(() => {});
  return { ok: true };
}

// ---- reminders --------------------------------------------------------------
// Every sweep: a ticked, live job whose board is not connected and which has not been posted by hand
// for N hours (counted from the day the task was made), or a hand-posted job that should come down for
// N hours, is reminded about ONCE A DAY per board. All the boards that are due for one job go in ONE
// message to the people who must act: whoever pressed Save & Post (the poster), the job's TL,
// recruiters and BDE. Stops by itself when the board is posted, unticked, connected or the job closes.
async function sweep() {
  const hours = await reminderHours();
  const cutoff = new Date(Date.now() - hours * 3600000);
  const rows = await prisma.requirementPosting.findMany({
    where: {
      source: { in: Object.keys(guide.GUIDE) },
      OR: [
        { status: { in: ['Integration Required', 'Setup Required'] }, createdAt: { lt: cutoff } },
        { status: HAND_REMOVE, updatedAt: { lt: cutoff } },
      ],
    },
    take: 500,
  });
  if (!rows.length) return { reminded: 0, jobs: 0 };
  const { notifyUsers } = require('../notify'); // eslint-disable-line global-require
  const posting = require('../jobPosting'); // eslint-disable-line global-require
  const connectors = require('../jobConnectors'); // eslint-disable-line global-require
  const { requirementIsLive } = require('../atsVocab'); // eslint-disable-line global-require
  const byJob = new Map();
  const orderOf = Object.keys(guide.GUIDE); // Naukri, Shine, Indeed, LinkedIn
  rows.sort((a, b) => orderOf.indexOf(a.source) - orderOf.indexOf(b.source));
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await prisma.requirement.findUnique({ where: { id: row.requirementId } });
    if (!r) continue; // eslint-disable-line no-continue
    const wantsDown = row.status === HAND_REMOVE;
    if (!wantsDown && !(requirementIsLive(r.status) && posting.siteTicked(r, row.source))) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (!wantsDown && (await connectors.boardIsReady(row.source))) continue; // it is connected now: Retry posts it, no hand needed
    const key = `${REMIND_PREFIX}${row.id}`;
    // eslint-disable-next-line no-await-in-loop
    const last = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
    if (last && Date.now() - new Date(last.updatedAt).getTime() < 24 * 3600000) continue; // eslint-disable-line no-continue
    if (!byJob.has(r.id)) byJob.set(r.id, { r, up: [], down: [], keys: [] });
    const g = byJob.get(r.id);
    (wantsDown ? g.down : g.up).push(guide.GUIDE[row.source].name);
    g.keys.push(key);
  }
  let reminded = 0;
  for (const { r, up, down, keys } of byJob.values()) {
    // The poster = the person who pressed Save & Post (the first audit row of the task, utils/jobConnectors.js).
    // eslint-disable-next-line no-await-in-loop
    const first = await prisma.auditLog.findFirst({
      where: { entity: ENTITY, entityId: r.id, userId: { not: null }, action: { in: ['Waiting to post by hand', 'Integration required', 'Setup required', 'Retry — Integration required'] } },
      orderBy: { createdAt: 'asc' }, select: { userId: true },
    });
    const who = [first && first.userId, r.tlId, r.recruiterId, ...csv(r.recruiterIds), r.bdeId].filter(Boolean);
    // eslint-disable-next-line no-await-in-loop
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set(who)] }, status: 'Active', NOT: [{ name: { contains: 'ZZTEST' } }, { email: { contains: 'example.test' } }] }, select: { id: true },
    });
    const code = r.reqCode || r.title;
    const list = (a) => a.join(', ');
    const parts = [];
    if (up.length) parts.push(`${up.length === 1 ? 'It is' : 'They are'} not posted yet on ${list(up)}. TeamLink cannot post there by itself, so a person posts ${up.length === 1 ? 'it' : 'them'}: open the job, press "Post by hand" and follow the 3 steps (the text is ready, it takes about a minute).`);
    if (down.length) parts.push(`The job is closed, paused or unticked but is still up on ${list(down)}. Open the job and press "I took it down" after you remove it there.`);
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(users.map((u) => u.id), {
      title: up.length ? `${code} is waiting to be posted on ${list(up)}` : `Take ${code} down from ${list(down)}`,
      message: parts.join(' '),
    });
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: new Date().toISOString() }, update: { value: new Date().toISOString() } });
    }
    reminded += keys.length;
  }
  return { reminded, jobs: byJob.size };
}

let timer = null;
function startSweep() {
  if (timer || process.env.TEST_MODE === '1' || process.env.TL_SANDBOX) return;
  const run = () => sweep().catch((e) => console.error('[post-by-hand] reminder sweep', e && e.message)); // eslint-disable-line no-console
  setTimeout(run, 90000);
  timer = setInterval(run, 30 * 60000);
}

module.exports = {
  HAND_DONE, HAND_REMOVE, REMINDER_KEY, DEFAULT_HOURS,
  fields, textBlock, applyLink, helper, markDone, markRemoved, markUndone, checkLink, sweep, startSweep, reminderHours, niceWhen,
};
