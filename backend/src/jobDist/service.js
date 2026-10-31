// ---------------------------------------------------------------------------
// JOB DISTRIBUTION SERVICE: what the "Distribute" tab of a job shows and does.
//
//   distribute(user, job, base)     every platform as a card: kind, ready text, tracked link, state, honest words
//   saveText / resetText            the poster's own edit of one platform's text
//
// WHO: anyone who may see the job (their own area) sees the tab; only the ones who may post it (TL, BDE team, Admin: the same
// right as Save & Post, jobPublish/access.js mayPost) copy-and-mark, edit text or mark taken down. A Recruiter reads only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { requirementIsLive } = require('../utils/atsVocab');
const access = require('../jobPublish/access');
const { API_PLACES } = require('../jobPublish/constants');
const Plat = require('./platforms');
const T = require('./text');
const Track = require('./tracker');
const G = require('./googleIndexing');

// TeamLink internal hiring never goes on the public job sites.
const INTERNAL_OK = ['career', 'referral'];

async function can(user, job) {
  return {
    view: await access.mayViewJob(user, job),
    post: await access.mayPost(user, job),
    admin: await access.isCredentialAdmin(user),
  };
}

function listed(job) {
  try { return require('../routes/careersPublic').isListed(job); } catch { return false; } // eslint-disable-line global-require
}

const autoState = (key, job, isListed) => {
  if (key === 'google') {
    return isListed
      ? { key: 'AUTO_ON', label: 'Automatic: on', tone: 'green', detail: 'Google reads the job page (it carries the job markup) and our site map. Google decides when it shows the job.' }
      : { key: 'AUTO_WAIT', label: 'Starts when the requirement is live', tone: 'yellow', detail: 'The requirement must be live on our careers page first (press Post this requirement).' };
  }
  if (key === 'feed') {
    return isListed
      ? { key: 'AUTO_ON', label: 'Automatic: in the feed', tone: 'green', detail: 'The requirement is in our RSS / XML feed for job aggregators.' }
      : { key: 'AUTO_WAIT', label: 'Starts when the requirement is live', tone: 'yellow', detail: 'The requirement must be live on our careers page first.' };
  }
  return null;
};

async function distribute(user, job, base) {
  const p = await can(user, job);
  const ctx = await T.context(job.id, { base });
  const s = await Track.settings();
  const now = Date.now();
  const platforms = await Plat.list();
  const rows = new Map((await Track.rowsOfJob(job.id)).map((r) => [r.platform, r]));
  const apps = await Track.sources([job.id]);
  const mine = apps.byJob.get(job.id) || {};
  const isListed = listed(job);
  const live = requirementIsLive(job.status);
  const gi = await G.status().catch(() => ({ enabled: false }));
  const cards = [];
  for (const pl of platforms) {
    if (job.internal && !INTERNAL_OK.includes(pl.key)) continue; // eslint-disable-line no-continue
    const card = {
      key: pl.key, name: pl.name, kind: pl.kind, medium: pl.medium, format: pl.format, postUrl: pl.postUrl, maxChars: pl.maxChars, formatHint: pl.formatHint, includeSalary: pl.includeSalary,
      expiryDays: pl.expiryDays, engine: pl.engine, applicants: mine[pl.key] || 0,
    };
    const auto = autoState(pl.key, job, isListed);
    if (auto) { card.state = auto; if (pl.key === 'google') card.indexing = { enabled: !!gi.enabled, canTell: !!gi.enabled && p.post }; } else if (pl.kind === 'auto') {
      card.state = null; // career / telegram / facebook: the honest chips of the posting engine are drawn from /api/job-publish
    } else {
      const row = rows.get(pl.key);
      card.state = Track.stateOf(row, now, s.reminderDays);
      card.posting = Track.view(row, now, s.reminderDays);
    }
    if (pl.kind !== 'auto' || API_PLACES.includes(pl.key)) {
      const built = T.withEdit(ctx, pl, T.build(ctx, pl));
      card.kit = {
        title: built.title, text: built.text, auto: built.auto, link: built.link, chars: built.chars, limit: built.limit, over: built.over, trimmed: built.trimmed, blanks: built.blanks,
        missing: built.missing, notes: built.notes, overridden: built.overridden, stale: built.stale, savedBy: built.savedBy, savedAt: built.savedAt, linkMissing: !!built.linkMissing,
      };
    }
    cards.push(card);
  }
  return {
    job: { id: job.id, title: job.title, reqCode: job.reqCode || null, status: job.status, live, internal: !!job.internal, listed: isListed },
    can: { post: p.post, edit: p.post, admin: p.admin },
    settings: s,
    cards,
    // the places that read as a worry on the Jobs list
    summary: cards.reduce((a, c) => { const k = c.state && c.state.key; if (k === 'POSTED' || k === 'EXPIRING') a.posted += 1; else if (k === 'EXPIRED') a.expired += 1; else if (c.kind !== 'auto' && (!c.state || c.state.key === 'NOT_POSTED')) a.pending += 1; return a; }, { posted: 0, expired: 0, pending: 0 }),
    closedChecklist: job.status === 'CLOSED' ? cards.filter((c) => c.posting && c.posting.state.key !== 'TAKEN_DOWN' && c.posting.takedown.state !== 'DONE').map((c) => ({ key: c.key, name: c.name, postUrl: c.posting.postUrl, openUrl: c.postUrl })) : [],
  };
}

async function saveText(user, job, key, body, base) {
  const pl = await Plat.get(key);
  if (!pl) return { error: 'This place is not in the list.', status: 404 };
  if (pl.kind === 'auto' && !API_PLACES.includes(pl.key)) return { error: `${pl.name} needs no text: TeamLink does it by itself.`, status: 400 };
  const ctx = await T.context(job.id, { base });
  const text = String((body && body.text) || '');
  if (text.trim().length > 30000) return { error: 'The text is too long.', status: 400 };
  await T.saveEdit(ctx, pl, text, body && body.title, user);
  const built = T.withEdit(ctx, pl, T.build(ctx, pl));
  return { kit: built };
}

// Applicants per platform (counts only) for one job.
async function jobSources(job) {
  const apps = await Track.sources([job.id]);
  const names = new Map((await Plat.list({ all: true })).map((p) => [p.key, p.name]));
  const mine = apps.byJob.get(job.id) || {};
  return Object.keys(mine).map((k) => ({ key: k, name: k === '_other' ? 'Other / direct' : (names.get(k) || k), applicants: mine[k] })).sort((a, b) => b.applicants - a.applicants);
}

module.exports = {
  distribute, saveText, jobSources, can, listed, INTERNAL_OK,
};
