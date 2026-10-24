// ---------------------------------------------------------------------------
// NAUKRI -> SHINE BY-HAND WORKFLOW: the saved state, the permission check and the audit trail (rules: jobFlow/logic.js).
//
//   state(user, jobId)                      where the recruiter is (rows, what is missing, the two official recruiter sites)
//   act(user, jobId, platform, event, body) one step: start | opened | await | confirm | opening | complete | fail | action | retry | unconfirm
//
// WHAT THIS DOES NOT DO: it never opens, logs in to or posts on Naukri or Shine, never stores a password, never fills a form
// on those sites. The browser opens the official recruiter pages (the same URLs as the "Post by hand" helper, utils/jobBoards/guide.js).
// "Naukri Completion Confirmed" is the recruiter's own button; TeamLink cannot see inside another site.
// WHO: the same people who may post a job (jobPublish/access.js mayPost) and the job must be in their area.
// Every step is written to the audit log. The table is created here when missing (CREATE TABLE IF NOT EXISTS), like utils/waChat.js.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const L = require('./logic');

const newId = () => `jf${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const ms = (v) => { if (v == null) return null; if (v instanceof Date) return v.getTime(); const n = typeof v === 'bigint' ? Number(v) : v; return typeof n === 'number' ? n : (Date.parse(n) || null); };

const DDL = [
  'CREATE TABLE IF NOT EXISTS "JobPostFlow" ("id" TEXT NOT NULL PRIMARY KEY, "requirementId" TEXT NOT NULL, "clientId" TEXT, "recruiterId" TEXT, "userId" TEXT, "userName" TEXT, "platform" TEXT NOT NULL, "status" TEXT NOT NULL, "externalJobId" TEXT, "portalUrl" TEXT, "startedAt" DATETIME, "completedAt" DATETIME, "lastError" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0, "meta" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "JobPostFlow_req_platform_key" ON "JobPostFlow"("requirementId", "platform")',
  'CREATE INDEX IF NOT EXISTS "JobPostFlow_status_idx" ON "JobPostFlow"("status")',
];

const WORDS = {
  start: 'Post workflow started', opened: 'Portal opened', await: 'Waiting for the recruiter to finish', confirm: 'Posting completed (confirmed by the recruiter)',
  opening: 'Opening Shine', complete: 'Shine posting completed by the recruiter', fail: 'Failed', action: 'Action required', retry: 'Retry',
  unconfirm: 'Undone by the recruiter (it was not posted after all)',
};
const NAME = { naukri: 'Naukri', shine: 'Shine' };

// deps are injectable so the tests can run against a COPY of the database with a fake permission check
function create(deps = {}) {
  const prisma = deps.prisma || require('../db'); // eslint-disable-line global-require
  const access = deps.access || require('../jobPublish/access'); // eslint-disable-line global-require
  const audit = deps.audit || require('../utils/audit').logAudit; // eslint-disable-line global-require
  const byHand = deps.byHand || require('../utils/jobBoards/manual'); // eslint-disable-line global-require
  const guide = deps.guide || require('../utils/jobBoards/guide'); // eslint-disable-line global-require
  const live = deps.live || require('../utils/atsVocab').requirementIsLive; // eslint-disable-line global-require
  const posting = deps.posting || (() => require('../utils/jobPosting')); // eslint-disable-line global-require

  const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
  const run = (sql, ...p) => prisma.$executeRawUnsafe(sql, ...p);

  let ensured = null;
  function ensureTable() {
    if (!ensured) ensured = (async () => { for (const sql of DDL) await run(sql); return true; })().catch((e) => { ensured = null; throw e; }); // eslint-disable-line no-await-in-loop
    return ensured;
  }

  const view = (r) => ({
    id: r.id, platform: r.platform, status: r.status, externalJobId: r.externalJobId || null, portalUrl: r.portalUrl || null,
    startedAt: ms(r.startedAt), completedAt: ms(r.completedAt), lastError: r.lastError || null, retryCount: Number(r.retryCount) || 0,
    updatedAt: ms(r.updatedAt), by: r.userName || null, standalone: !!(r.meta && safeJson(r.meta).standalone),
  });
  function safeJson(t) { try { return JSON.parse(t) || {}; } catch { return {}; } }
  async function rowsOf(id) { return q('SELECT * FROM "JobPostFlow" WHERE "requirementId" = ? ORDER BY "platform"', id); }
  const urlOf = (platform) => (guide.GUIDE[platform] || {}).openUrl || null; // the official recruiter site (same list as "Post by hand")

  async function jobFor(user, id, { post }) {
    const job = await prisma.requirement.findUnique({ where: { id: String(id) } });
    if (!job) return { error: 'Requirement not found.', status: 404 };
    if (!access.inScope(user, job)) return { error: 'This requirement is not in your area.', status: 403 };
    if (post) {
      if (!(await access.mayPost(user, job))) return { error: 'Posting requirements is done by your team lead or the client manager.', code: 'POSTING_NOT_YOURS', status: 403 };
    } else if (!(await access.mayViewJob(user, job))) return { error: 'This requirement is not in your area.', status: 403 };
    return { job };
  }

  async function snapshot(job) {
    const rows = (await rowsOf(job.id)).map(view);
    return {
      requirementId: job.id, missing: L.missingFields(job), live: !!live(job.status),
      urls: { naukri: urlOf('naukri'), shine: urlOf('shine') }, rows, resume: L.resume(rows),
    };
  }

  async function state(user, jobId) {
    await ensureTable();
    const got = await jobFor(user, jobId, { post: false });
    if (got.error) return got;
    return snapshot(got.job);
  }

  async function log(user, job, platform, event, from, to, note) {
    await Promise.resolve(audit({
      userId: user.id, actorName: user.name, action: `Post workflow: ${WORDS[event] || event}`, entity: 'Requirement', entityId: job.id,
      fromValue: `${NAME[platform]}: ${from || 'Not started'}`, toValue: `${NAME[platform]}: ${to}${note ? ` (${clip(note, 160)})` : ''}`,
    })).catch(() => {});
  }

  // the board is ticked for the job, like the by-hand "I posted it" does
  async function tick(job, board) {
    try {
      const P = posting();
      if (P.tickedSites(job).includes(board)) return;
      await prisma.requirement.update({ where: { id: job.id }, data: { postingSources: P.postingSourcesFor(job, [...P.tickedSites(job), board]) } });
    } catch { /* the ticks are a convenience: the by-hand record below is what counts */ }
  }

  async function act(user, jobId, platform, event, body = {}) {
    if (!L.PLATFORMS.includes(platform)) return { error: 'This place is not part of the workflow.', status: 404 };
    await ensureTable();
    const got = await jobFor(user, jobId, { post: true });
    if (got.error) return got;
    const { job } = got;
    const b = body || {};
    const rows = await rowsOf(job.id);
    const mine = rows.find((r) => r.platform === platform) || null;
    const nrow = rows.find((r) => r.platform === 'naukri') || null;
    const from = mine ? mine.status : null;
    const standalone = !!(b.standalone || (mine && mine.meta && safeJson(mine.meta).standalone));

    if (['start', 'confirm', 'opening', 'complete'].includes(event) && !live(job.status)) {
      return { error: 'This requirement is not open yet, so it should not be posted. Open the requirement first.', code: 'JOB_NOT_OPEN', status: 400 };
    }
    if (platform === 'naukri' && event === 'start') {
      const missing = L.missingFields(job);
      if (missing.length) return { error: `Fill these first, then post: ${missing.join(', ')}.`, code: 'MISSING_FIELDS', missing, status: 400 };
    }
    const to = L.next(platform, from, event, { naukri: nrow && nrow.status, standalone });
    if (!to) {
      const why = platform === 'shine' && event === 'opening' && !(nrow && nrow.status === L.STATUS.NAUKRI_CONFIRMED) ? 'Shine opens after you confirm that the Naukri posting is completed.'
        : event === 'unconfirm' ? 'There is nothing to undo here.'
        : event === 'confirm' ? 'Open Naukri first, post the requirement there, then confirm.'
          : 'That step is not possible right now. Reload the page to see where you are.';
      return { error: why, code: 'WRONG_STEP', status: 409, ...(await snapshot(job)) };
    }

    // UNDO ("I pressed it by mistake"): the by-hand record on the real board row is removed, and Shine (which opened because of Naukri) waits again.
    const undoing = event === 'unconfirm';
    if (undoing) {
      const srow = rows.find((r) => r.platform === 'shine') || null;
      if (platform === 'naukri' && srow && srow.status === L.STATUS.DONE) return { error: 'Undo the Shine posting first, then Naukri.', code: 'UNDO_SHINE_FIRST', status: 409, ...(await snapshot(job)) };
      const u = await byHand.markUndone(job, platform, user);
      if (u && u.error && u.status !== 409) return { error: u.error, status: u.status || 400, ...(await snapshot(job)) };
      if (platform === 'naukri' && srow && !safeJson(srow.meta).standalone) {
        await run('UPDATE "JobPostFlow" SET "status"=?, "lastError"=NULL, "updatedAt"=? WHERE "requirementId"=? AND "platform"=?', L.STATUS.SAVED, Date.now(), job.id, 'shine');
      }
    }
    // The recruiter's own confirmation is the only thing that records "posted by hand" on the real board row.
    const boardDone = (platform === 'naukri' && event === 'confirm') || (platform === 'shine' && event === 'complete');
    if (boardDone && from !== to) {
      const out = await byHand.markDone(job, platform, user, b.url);
      if (out && out.error) return { error: out.error, status: out.status || 400, ...(await snapshot(job)) };
      await tick(job, platform);
    }

    const now = Date.now();
    const failing = ['fail', 'action'].includes(event);
    const note = failing ? clip(L.REASONS[b.code] || b.message || '', 300) : null;
    const meta = JSON.stringify({ ...(mine && mine.meta ? safeJson(mine.meta) : {}), ...(standalone ? { standalone: true } : {}), ...(b.code ? { lastCode: clip(b.code, 40) } : {}) });
    const retry = (mine ? Number(mine.retryCount) || 0 : 0) + (failing || event === 'retry' ? 1 : 0);
    const portalUrl = ['start', 'opening', 'opened', 'retry'].includes(event) ? urlOf(platform) : (mine && mine.portalUrl) || urlOf(platform);
    const started = (mine && ms(mine.startedAt)) || (['opened', 'opening'].includes(event) ? now : null);
    const done = undoing ? null : (boardDone ? now : (mine && ms(mine.completedAt)) || null);
    if (!mine) {
      await run(
        'INSERT INTO "JobPostFlow" ("id","requirementId","clientId","recruiterId","userId","userName","platform","status","externalJobId","portalUrl","startedAt","completedAt","lastError","retryCount","meta","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        newId(), job.id, job.clientId || null, (Array.isArray(job.recruiterIds) ? job.recruiterIds[0] : String(job.recruiterIds || '').split(',')[0]) || null, user.id || null, user.name || null,
        platform, to, clip(b.externalJobId, 80) || null, portalUrl, started, done, note, retry, meta, now, now,
      );
    } else {
      await run(
        'UPDATE "JobPostFlow" SET "status"=?, "userId"=?, "userName"=?, "externalJobId"=?, "portalUrl"=?, "startedAt"=?, "completedAt"=?, "lastError"=?, "retryCount"=?, "meta"=?, "updatedAt"=? WHERE "requirementId"=? AND "platform"=?',
        to, user.id || mine.userId || null, user.name || mine.userName || null, clip(b.externalJobId, 80) || mine.externalJobId || null, portalUrl, started, done,
        failing ? note : (['start', 'opened', 'retry', 'confirm', 'opening', 'complete', 'unconfirm'].includes(event) ? null : mine.lastError), retry, meta, now, job.id, platform,
      );
    }
    await log(user, job, platform, event, from, to, failing ? (b.code || b.message) : null);
    return { ok: true, status: 200, ...(await snapshot(job)) };
  }

  return { ensureTable, state, act };
}

let shared = null;
const get = () => { if (!shared) shared = create(); return shared; };
module.exports = { create, get, DDL };
