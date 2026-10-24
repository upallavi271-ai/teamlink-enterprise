// ---------------------------------------------------------------------------
// PUBLISH DIAGNOSTICS: what the "Health" screens show (Integrations > Job portals, and the Posting tab of Jobs).
//
//   overview(user)   per portal: health + the plain list of what is wrong, last attempts, failures by group
//                    (sign-in, OTP, CAPTCHA, page changed, site refused the job, site down, held back), pictures,
//                    selector status (ok / drift / broken / not tried yet), session age, retry flags.
//   attempt(user,id) ONE attempt in full: its log lines, its pictures and page snapshots, selector events.
//   setRetention / sweepPictures   how long pictures are kept (default 30 days) and the clean-up.
//
// Read-only except the retention setting. Scope: an Admin sees everything; a team lead / client manager sees the attempts of
// jobs in their own area (access.scopedIds) and no login details. Nothing here ever holds a secret, a typed value or a
// picture's content (the pictures are fetched one by one through the protected route).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const C = require('./constants');
const S = require('./settings');
const Q = require('./queue');
const Cred = require('./credentials');
const access = require('./access');
const guards = require('./guards');
const cfgLib = require('../portals/config');
const session = require('../playwright/session');
const shots = require('../playwright/screenshot');
const browserLib = require('../playwright/browser');
const {
  q, iso, ms, ex,
} = require('./db');

const DAY = 86400000;
const SELECTOR_EVENT_STEPS = ['selector-drift', 'selector-broken', 'selector-ambiguous'];
const STEP_STATE_WORDS = {
  ok: 'Works (the main way found it)', drift: 'Drift: the main way failed, a fallback worked', broken: 'Broken: nothing found it', unknown: 'Not tried yet',
};

const ageWords = (hours) => {
  if (hours == null) return 'unknown';
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};

async function jobsOf(ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await prisma.requirement.findMany({ where: { id: { in: list } }, select: { id: true, title: true, reqCode: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

// the pictures per queue entry (counted from the log, so a picture removed by the retention sweep is not counted)
async function pictureCounts(queueIds) {
  const out = new Map();
  if (!queueIds.length) return out;
  const rows = await q(`SELECT "queueId", COUNT(*) n FROM "PostingLog" WHERE "screenshotPath" IS NOT NULL AND "screenshotPath" NOT LIKE '%.txt' AND "queueId" IN (${queueIds.map(() => '?').join(',')}) GROUP BY "queueId"`, ...queueIds);
  rows.forEach((r) => out.set(r.queueId, r.n));
  return out;
}

function selectorView(portal, loaded, status) {
  const cov = loaded && loaded.cfg ? cfgLib.coverage(loaded.cfg) : [];
  const stepsStatus = (status && status.steps) || {};
  const list = cfgLib.stepList(loaded && loaded.cfg);
  const mainOf = new Map(list.map((s) => [s.key, s.list[0]]));
  const locate = require('../playwright/locate'); // eslint-disable-line global-require
  const steps = cov.map((c) => {
    const st = stepsStatus[c.key];
    return {
      key: c.key, label: c.label, state: st ? st.state : 'unknown', stateWords: STEP_STATE_WORDS[st ? st.state : 'unknown'],
      main: locate.describe(mainOf.get(c.key)), used: st ? st.used : null, usedIndex: st ? st.usedIndex : null, usedKind: st ? st.kind : null, at: st ? st.at : null,
      ways: c.count, families: c.families, thin: c.thin, onlyCss: c.textless,
    };
  });
  const count = (s) => steps.filter((x) => x.state === s).length;
  return {
    version: loaded ? loaded.version : null,
    verified: !!(loaded && loaded.verified),
    label: loaded && loaded.verified ? 'Verified against the real site' : 'UNVERIFIED: written from the public look of the site, not yet checked on the real one',
    settingsFile: loaded ? loaded.origin : null,
    problems: loaded ? loaded.problems : ['The page settings could not be read.'],
    lastRunAt: status ? status.lastRunAt : null,
    counts: {
      total: steps.length, ok: count('ok'), drift: count('drift'), broken: count('broken'), unknown: count('unknown'),
    },
    steps,
  };
}

// -> the plain list of what needs attention for one browser portal + a state
function healthOf({
  meta, loaded, cred, worker, selectors, sess, hold, kill, fails, realOk,
}) {
  const issues = [];
  let state = 'OK';
  const bad = (t) => { issues.push(t); state = 'BROKEN'; };
  const warn = (t) => { issues.push(t); if (state === 'OK') state = 'ATTENTION'; };
  if (kill.killedAll || kill.killedOne) bad('Posting here is stopped by the big stop switch.');
  if (!loaded.ok) bad(`The page settings are not valid: ${loaded.problems.join('; ')}.`);
  if (!browserLib.findBrowser()) bad('No Chrome or Edge was found on this computer.');
  if (!cred.hasLogin) warn('No login is saved yet.');
  else if (cred.status === 'FAILED') bad('The saved login does not work (wrong login name or password).');
  else if (cred.lastTest && cred.lastTest.state && !['CONNECTED', 'NOT_TESTED', 'TESTING'].includes(cred.lastTest.state)) warn(`The last Test connection said: ${cred.lastTest.words}.`);
  else if (cred.hasLogin && cred.lastTest && cred.lastTest.state === 'NOT_TESTED') warn('The login has not been tested yet. Press Test connection.');
  if (!cred.enabled) warn('Automatic posting is switched OFF for this site (this is the normal starting point).');
  if (hold) warn(`Waiting for a person: ${hold.reason || 'open the portal session'}.`);
  if (!worker.running) warn('The posting helper is not running (npm run posting-worker).');
  if (!selectors.verified) warn('The page settings are UNVERIFIED. A real post is refused until they are calibrated (docs/job-publishing/CALIBRATION.md).');
  if (selectors.counts.broken) bad(`${selectors.counts.broken} step(s) cannot find their button or box on the site any more (the site may have changed).`);
  if (selectors.counts.drift) warn(`${selectors.counts.drift} step(s) only worked through a fallback: the site changed a little. Update the page settings.`);
  if (!realOk) warn('Real posting is not allowed on this computer (TL_ALLOW_REAL_POSTING is not 1). A Dry run still works.');
  if (sess.saved && sess.ageHours != null && sess.ageHours > 24 * 14) warn(`The saved browser session was last used ${ageWords(sess.ageHours)}. It may have expired: sign in again.`);
  if (!sess.saved) issues.push('No browser session is saved yet (the first real run signs in with the saved login, or a person opens the session).');
  if (fails.total >= 3 && fails.rate != null && fails.rate < 0.5) warn(`Most recent attempts failed (${fails.failed} of ${fails.total}).`);
  return { state, issues, words: { OK: 'Looks fine', ATTENTION: 'Needs attention', BROKEN: 'Broken' }[state] };
}

async function overview(user, { days = 30 } = {}) {
  const admin = await access.isCredentialAdmin(user);
  const ids = await access.scopedIds(user);
  const since = Date.now() - Math.max(1, Math.min(90, Number(days) || 30)) * DAY;
  const [worker, killAll, retention] = await Promise.all([S.workerState(), S.killState(null), S.retentionDays()]);
  const where = ['"createdAt" >= ?']; const p = [since];
  if (ids) {
    if (!ids.length) where.push('1=0'); else { where.push(`"requirementId" IN (${ids.map(() => '?').join(',')})`); p.push(...ids); }
  }
  const rows = await q(`SELECT * FROM "PostingQueue" WHERE ${where.join(' AND ')} ORDER BY "createdAt" DESC LIMIT 1500`, ...p);
  const shaped = rows.map(Q.shape);
  const pics = await pictureCounts(shaped.slice(0, 200).map((r) => r.id));
  const jobs = await jobsOf(shaped.slice(0, 200).map((r) => r.requirementId));
  const realOk = guards.realPostingAllowed();
  const portals = [];
  for (const portal of C.PORTAL_KEYS) {
    const meta = C.PORTALS[portal];
    const mine = shaped.filter((r) => r.portal === portal);
    const done = mine.filter((r) => ['SUCCEEDED', 'FAILED', 'DEAD', 'NEEDS_HUMAN'].includes(r.status));
    const failed = done.filter((r) => ['FAILED', 'DEAD', 'NEEDS_HUMAN'].includes(r.status));
    const byCategory = Object.fromEntries(Object.keys(C.CATEGORIES).map((k) => [k, 0]));
    failed.forEach((r) => { byCategory[C.categoryOf(r.errorCode)] += 1; });
    const driftRuns = mine.filter((r) => r.selectorDrift > 0).length;
    const fails = {
      total: done.length, failed: failed.length, succeeded: done.length - failed.length, rate: done.length ? (done.length - failed.length) / done.length : null, byCategory, driftRuns,
    };
    const entry = {
      portal, name: meta.name, kind: meta.kind, manualOnly: meta.kind === 'manual', note: meta.note, failures: fails,
      lastAttempts: mine.slice(0, 8).map((r) => ({
        id: r.id, action: r.action, status: r.status, statusWords: r.statusWords, dryRun: r.dryRun, attempts: r.attempts, maxAttempts: r.maxAttempts,
        errorCode: r.errorCode, category: r.errorCode ? C.categoryOf(r.errorCode) : null, categoryWords: r.errorCode ? C.CATEGORIES[C.categoryOf(r.errorCode)].words : null,
        reason: r.errorMessage, at: r.finishedAt || r.startedAt || r.createdAt, requirementId: r.requirementId,
        job: r.requirementId && jobs.get(r.requirementId) ? { title: jobs.get(r.requirementId).title, reqCode: jobs.get(r.requirementId).reqCode } : null,
        pictures: pics.get(r.id) || 0, selectorDrift: r.selectorDrift, waiting: r.waiting, help: r.help,
        canRetry: ['FAILED', 'DEAD', 'NEEDS_HUMAN', 'CANCELLED'].includes(r.status),
      })),
    };
    if (meta.kind === 'browser') {
      const loaded = await cfgLib.load(portal);
      const status = await S.selectorStatus(portal);
      const sel = selectorView(portal, loaded, status);
      const sess = session.info(portal);
      const cred = admin ? await Cred.one(portal) : await Cred.posterView(portal);
      const [hold, kill] = await Promise.all([S.humanHold(portal), S.killState(portal)]);
      entry.credential = {
        hasLogin: cred.hasLogin, status: cred.status, statusWords: cred.statusWords, enabled: cred.enabled, lastTest: cred.lastTest, lastVerifiedAt: cred.lastVerifiedAt, lastError: cred.lastError, usernameMasked: admin ? cred.usernameMasked : undefined,
      };
      entry.session = {
        saved: sess.saved, lastUsedAt: sess.lastUsedAt ? iso(sess.lastUsedAt) : null, ageHours: sess.ageHours, ageWords: sess.saved ? `last used ${ageWords(sess.ageHours)}` : 'no session saved',
        stale: !!(sess.saved && sess.ageHours != null && sess.ageHours > 24 * 14),
      };
      entry.selectors = sel;
      entry.humanHold = hold ? { at: hold.at, reason: hold.reason || null } : null;
      entry.health = healthOf({
        meta, loaded, cred: { ...cred, ...entry.credential }, worker, selectors: sel, sess, hold, kill, fails, realOk,
      });
    } else if (meta.kind === 'api') {
      // Telegram / Facebook: a token, an Admin switch, the API's own answers (no page settings, no pictures)
      const cred = admin ? await Cred.one(portal) : await Cred.posterView(portal);
      const kill = await S.killState(portal);
      entry.credential = {
        hasLogin: cred.hasLogin, status: cred.status, statusWords: cred.statusWords, enabled: cred.enabled, lastTest: cred.lastTest, lastVerifiedAt: cred.lastVerifiedAt, lastError: cred.lastError, usernameMasked: admin ? cred.usernameMasked : undefined,
      };
      const issues = [];
      if (!cred.hasLogin) issues.push('No token is saved yet. An Admin saves it under Integrations, Job portals.');
      else if (!cred.enabled) issues.push('Posting is switched off. An Admin switches it on when ready.');
      if (cred.status === 'FAILED') issues.push(cred.lastError || 'The token was not accepted.');
      if (kill.killedAll || kill.killedOne) issues.push('Posting is paused by an Admin.');
      if (fails.rate != null && fails.rate < 0.5 && fails.total >= 3) issues.push('Most recent posts failed.');
      entry.health = { state: issues.length ? (cred.status === 'FAILED' ? 'BROKEN' : 'ATTENTION') : 'OK', words: issues.length ? issues[0] : 'Ready', issues };
    } else {
      entry.health = { state: 'OK', words: meta.kind === 'manual' ? 'By hand (no program)' : 'Always ready', issues: [] };
    }
    portals.push(entry);
  }
  const all = portals.reduce((a, x) => ({
    attempts: a.attempts + x.failures.total, failed: a.failed + x.failures.failed, drift: a.drift + x.failures.driftRuns, needsHelp: a.needsHelp + x.lastAttempts.filter((r) => r.status === 'NEEDS_HUMAN' || r.waiting).length,
  }), { attempts: 0, failed: 0, drift: 0, needsHelp: 0 });
  const use = shots.usage();
  return {
    generatedAt: new Date().toISOString(), days: Math.round((Date.now() - since) / DAY), canAdmin: admin,
    worker, killAll: killAll.killedAll, paused: killAll.paused, realPostingAllowed: realOk,
    retention: { days: retention, files: use.files, bytes: use.bytes, oldestAt: use.oldestAt ? iso(use.oldestAt) : null },
    categories: Object.fromEntries(Object.entries(C.CATEGORIES).map(([k, v]) => [k, v.words])),
    totals: all, portals,
  };
}

// One attempt in full. -> { entry, job, logs, files, selectorEvents } | { error, status }
async function attempt(user, queueId) {
  const row = await Q.byId(queueId);
  if (!row) return { error: 'No such attempt', status: 404 };
  let job = null;
  if (row.requirementId) {
    const r = await prisma.requirement.findUnique({ where: { id: row.requirementId } });
    if (!r || !access.inScope(user, r)) return { error: 'This requirement is not in your area.', status: 403 };
    job = { id: r.id, title: r.title, reqCode: r.reqCode };
  } else if (!(await access.isCredentialAdmin(user))) return { error: 'Only an Admin can see a login check.', status: 403 };
  const logs = await q('SELECT * FROM "PostingLog" WHERE "queueId" = ? ORDER BY "createdAt" ASC, "id" ASC LIMIT 300', queueId);
  const mapped = logs.map((l) => ({
    id: l.id, step: l.step, level: l.level, message: l.message, at: iso(l.createdAt), durationMs: l.durationMs, fileKind: l.screenshotPath ? shots.kindOfPath(l.screenshotPath) : null,
  }));
  return {
    entry: Q.shape(row), job, logs: mapped,
    files: mapped.filter((l) => l.fileKind).map((l) => ({ logId: l.id, kind: l.fileKind, step: l.step, at: l.at })),
    selectorEvents: mapped.filter((l) => SELECTOR_EVENT_STEPS.includes(l.step)),
  };
}

async function setRetention(user, days) {
  const out = await S.setRetentionDays(days, user);
  if (out.error) return { error: out.error, status: 400 };
  return { ok: true, days: out.days };
}

// Delete pictures older than the retention and unlink their log rows. -> { removed, kept, days }
async function sweepPictures({ now = Date.now(), force = false } = {}) {
  const last = await S.get(S.K.sweepAt);
  const lastAt = last && last.value ? ms(last.value) : 0;
  if (!force && lastAt && now - lastAt < 3600000) return { skipped: true, removed: 0 };
  const days = await S.retentionDays();
  const out = shots.sweepOld(days, now);
  for (let i = 0; i < out.paths.length; i += 200) {
    const chunk = out.paths.slice(i, i + 200);
    // eslint-disable-next-line no-await-in-loop
    await ex(`UPDATE "PostingLog" SET "screenshotPath" = NULL WHERE "screenshotPath" IN (${chunk.map(() => '?').join(',')})`, ...chunk).catch(() => {});
  }
  await S.put(S.K.sweepAt, new Date(now).toISOString());
  return { removed: out.removed, kept: out.kept, days };
}

module.exports = {
  overview, attempt, setRetention, sweepPictures, STEP_STATE_WORDS,
};
