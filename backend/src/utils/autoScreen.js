// ---------------------------------------------------------------------------
// AUTOMATIC SCREENING (founder 2026-11-23, "4. Automatic screening (optional)").
//
// Per requirement (and an Admin default for jobs without their own setting): "Auto-screen new applications".
// OFF BY DEFAULT for every job, and the Admin default is OFF.
//
// When it is on and a new application arrives - any door: job portal, careers page, job boards, imports, a recruiter's
// "Add" (the Prisma hook in db.js calls onNewApplication a few seconds after the row is written, so the apply-form
// answers are in) - the application is scored IN CODE against the job:
//   skills          the job's must-have skills against the profile / resume (utils/matching.js computeMatch)
//   experience      the job's range ("2-5 years", "3+") against the person's years
//   pay             expected pay against the budget (utils/salaryFit.js) - the words never carry the amounts
//   notice          notice period against the job's longest allowed notice
//   location        the job's city against where the person lives / wants to work
//   knock-out       the job's screening questions (utils/mktb/jobs.js) - a failed knock-out answer
//   duplicate/fraud another candidate record with the same phone / e-mail on this job, an open fraud flag (utils/mktb)
//   Fit (optional)  the existing match score (no AI call, nothing about the person leaves the server), only when the job
//                   ticks "Also use the match score"
// -> a visible result on the application: Pass / Review / Not suitable + the reasons ("AtsScreenResult"), and the
//    Candidates list can filter on it (?screening=pass,review,notsuitable,none).
//
// SUGGEST ONLY unless the job's TL (or a manager / Admin) ticks "Act on the result" for that job:
//   Pass          a NEW application moves to Recruiter check
//   Not suitable  put ON HOLD - or REJECTED only when the company's auto-reject rule (AI governance > Automations,
//                 utils/mktb/pipe.js) is switched on; every automatic move goes to the human review queue with an undo.
//   Review        nothing moves
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SETTINGS_KEY = 'ats-autoscreen';
const RESULTS = { pass: 'Pass', review: 'Review', notsuitable: 'Not suitable' };
const EARLY = ['NEW', 'AI_INTERVIEW_REQUIRED', 'RECRUITER_REVIEW'];
const iso = (d = new Date()) => new Date(d).toISOString();

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "AtsAutoScreenJob" ("requirementId" TEXT PRIMARY KEY, "enabled" INTEGER NOT NULL DEFAULT 0, "act" INTEGER NOT NULL DEFAULT 0, "useFit" INTEGER NOT NULL DEFAULT 0, "byName" TEXT, "at" TEXT)');
      await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "AtsScreenResult" ("applicationId" TEXT PRIMARY KEY, "requirementId" TEXT, "candidateId" TEXT, "result" TEXT NOT NULL, "score" INTEGER, "reasons" TEXT, "checks" TEXT, "acted" TEXT, "byName" TEXT, "at" TEXT NOT NULL)');
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "AtsScreenResult_req" ON "AtsScreenResult" ("requirementId")');
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = async (sql, ...a) => { await ensure(); return prisma.$queryRawUnsafe(sql, ...a); };
const x = async (sql, ...a) => { await ensure(); return prisma.$executeRawUnsafe(sql, ...a); };

// ---- settings ---------------------------------------------------------------------------------------------------------
let CACHE = { at: 0, def: null, jobs: new Map() };
const forget = () => { CACHE = { at: 0, def: null, jobs: new Map() }; };
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return { defaultOn: v.defaultOn === true, defaultAct: false };
}
async function saveSettings(user, body = {}) {
  const next = { defaultOn: body.defaultOn === true };
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name }, create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name } });
  await require('./audit').logAudit({ userId: user.id, action: `Auto-screen default ${next.defaultOn ? 'ON' : 'OFF'} for new jobs`, entity: 'Setting', entityId: SETTINGS_KEY }).catch(() => {}); // eslint-disable-line global-require
  forget();
  return { ...next, defaultAct: false, canEdit: true };
}
async function jobSetting(requirementId) {
  const [r] = await q('SELECT * FROM "AtsAutoScreenJob" WHERE "requirementId" = ?', requirementId);
  if (r) return { requirementId, own: true, enabled: !!Number(r.enabled), act: !!Number(r.act), useFit: !!Number(r.useFit), byName: r.byName, at: r.at };
  const s = await settings();
  return { requirementId, own: false, enabled: s.defaultOn, act: false, useFit: false, byName: null, at: null };
}
async function saveJob(user, job, body = {}) {
  const cur = await jobSetting(job.id);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : cur.enabled;
  const act = enabled && (typeof body.act === 'boolean' ? body.act : cur.act);
  const useFit = typeof body.useFit === 'boolean' ? body.useFit : cur.useFit;
  await x('INSERT INTO "AtsAutoScreenJob" ("requirementId","enabled","act","useFit","byName","at") VALUES (?,?,?,?,?,?) ON CONFLICT("requirementId") DO UPDATE SET "enabled"=excluded."enabled","act"=excluded."act","useFit"=excluded."useFit","byName"=excluded."byName","at"=excluded."at"',
    job.id, enabled ? 1 : 0, act ? 1 : 0, useFit ? 1 : 0, user.name, iso());
  await require('./audit').logAudit({ userId: user.id, action: `Auto-screen ${enabled ? 'ON' : 'OFF'}${act ? ' (acts on the result)' : enabled ? ' (suggest only)' : ''}`, entity: 'Requirement', entityId: job.id, toValue: job.title }).catch(() => {}); // eslint-disable-line global-require
  forget();
  return jobSetting(job.id);
}
// Who may switch it for a job: an Admin / management, the job's own TL / STL, or a TL / STL / Manager whose scope holds the job.
async function mayEdit(user, job) {
  const S = require('./scope'); // eslint-disable-line global-require
  if ([user.role, user.atsRole].some((r) => ['BDE', 'CLIENT', 'CANDIDATE', 'RECRUITER'].includes(r)) || S.isBdeTl(user)) return [user.role, user.atsRole].some((r) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
  const role = S.atsViewRole(user);
  if (role === 'admin' || role === 'mgmt') return true;
  if ([job.tlId, job.stlId].includes(user.id)) return true;
  try { if (require('./reqTeamLeads').tlsOf(job).includes(user.id)) return true; } catch { /* no extras */ } // eslint-disable-line global-require
  return ['TL', 'STL', 'MANAGER'].includes(user.atsRole) && !S.isBdeTl(user);
}
async function autoRejectOn() {
  try { return !!(await require('./mktb/store').setting('autoReject.on')); } catch { return false; } // eslint-disable-line global-require
}

// ---- the checks (pure where it can be) -----------------------------------------------------------------------------------
function expRange(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  if (/fresher/.test(s) && !/\d/.test(s)) return { lo: 0, hi: 1 };
  const r = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
  if (r) return { lo: Number(r[1]), hi: Number(r[2]) };
  const plus = s.match(/(\d+(?:\.\d+)?)\s*\+|(?:min(?:imum)?|at least|above)\s*(\d+(?:\.\d+)?)/);
  if (plus) return { lo: Number(plus[1] || plus[2]), hi: null };
  const one = s.match(/(\d+(?:\.\d+)?)/);
  return one ? { lo: Number(one[1]), hi: null } : null;
}
function noticeDays(v) {
  const t = String(v == null ? '' : v).toLowerCase().trim();
  if (!t) return null;
  if (/immediate|serving|^0\s*(days?)?$|no notice/.test(t)) return 0;
  const n = Number((t.match(/\d+(?:\.\d+)?/) || [])[0]);
  if (!Number.isFinite(n)) return null;
  return Math.round(/month/.test(t) ? n * 30 : /week/.test(t) ? n * 7 : n);
}
// -> [{ key, label, state: pass | review | fail | na, why }]
function checksFor({ candidate, requirement, match, salary, knock, dupes, flags, useFit }) {
  const out = [];
  const add = (key, label, state, why) => out.push({ key, label, state, why });
  // skills
  if (!match || !match.mandatoryCount) add('skills', 'Skills', 'na', 'The job lists no must-have skills.');
  else if (!match.missingSkills.length) add('skills', 'Skills', 'pass', `Has all ${match.mandatoryCount} must-have skills.`);
  else if (match.matchedSkills.length * 2 >= match.mandatoryCount) add('skills', 'Skills', 'review', `Missing ${match.missingSkills.slice(0, 4).join(', ')}.`);
  else add('skills', 'Skills', 'fail', `Missing most must-have skills (${match.missingSkills.slice(0, 4).join(', ')}).`);
  // experience
  const rg = expRange(requirement.experience);
  const yrs = candidate.experienceYears;
  if (!rg) add('experience', 'Experience', 'na', 'The job gives no experience range.');
  else if (yrs == null) add('experience', 'Experience', 'review', 'Years of experience not known.');
  else if (yrs < rg.lo - 1) add('experience', 'Experience', 'fail', `${yrs} years, the job needs ${rg.lo}${rg.hi != null ? `-${rg.hi}` : '+'}.`);
  else if (yrs < rg.lo) add('experience', 'Experience', 'review', `${yrs} years, a little under ${rg.lo}.`);
  else if (rg.hi != null && yrs > rg.hi + 3) add('experience', 'Experience', 'review', `${yrs} years, well above ${rg.hi}.`);
  else add('experience', 'Experience', 'pass', `${yrs} years fits ${rg.lo}${rg.hi != null ? `-${rg.hi}` : '+'}.`);
  // pay (words only, never the amounts)
  const sb = salary && (salary.band || salary.state);
  if (!salary || salary.state === 'no-budget') add('pay', 'Pay vs budget', 'na', 'The job has no budget.');
  else if (salary.state === 'no-salary' || salary.missing === 'expected' || salary.missing === 'both') add('pay', 'Pay vs budget', 'review', 'Expected pay not known.');
  else if (sb === 'within') add('pay', 'Pay vs budget', 'pass', 'Expected pay is within the budget.');
  else if (sb === 'slightly') add('pay', 'Pay vs budget', 'review', 'Expected pay is slightly above the budget.');
  else if (sb === 'above') add('pay', 'Pay vs budget', 'fail', 'Expected pay is well above the budget.');
  else add('pay', 'Pay vs budget', 'na', 'Pay could not be compared.');
  // notice
  const nd = noticeDays(candidate.noticePeriod);
  const nmax = noticeDays(requirement.noticePeriodMax);
  if (nmax == null) add('notice', 'Notice period', 'na', 'The job gives no notice limit.');
  else if (nd == null) add('notice', 'Notice period', 'review', 'Notice period not known.');
  else if (nd <= nmax) add('notice', 'Notice period', 'pass', `${candidate.noticePeriod} is within ${requirement.noticePeriodMax}.`);
  else if (nd <= nmax + 30) add('notice', 'Notice period', 'review', `${candidate.noticePeriod} is above ${requirement.noticePeriodMax}.`);
  else add('notice', 'Notice period', 'fail', `${candidate.noticePeriod} is far above ${requirement.noticePeriodMax}.`);
  // location
  const remote = /remote|work from home|wfh/i.test(String(requirement.workMode || ''));
  if (!requirement.location || remote) add('location', 'Location', 'na', remote ? 'Remote job.' : 'The job gives no location.');
  else if (!candidate.location && !candidate.preferredLocation) add('location', 'Location', 'review', 'Where the person lives is not known.');
  else if (match && match.locationMatched) add('location', 'Location', 'pass', `Near ${requirement.location}.`);
  else add('location', 'Location', 'review', `Not in ${requirement.location} - ask about relocating.`);
  // knock-out answers
  if (!knock) add('knockout', 'Screening questions', 'na', 'No screening questions answered.');
  else if (knock.failed && knock.failed.length) add('knockout', 'Screening questions', 'fail', `Knock-out: ${knock.failed.map((f) => `${f.text} (${f.rule})`).slice(0, 3).join('; ')}.`);
  else add('knockout', 'Screening questions', 'pass', 'All knock-out answers are fine.');
  // duplicates / fraud
  if (dupes > 0 || (flags && flags.length)) add('duplicate', 'Duplicate / fraud check', 'review', [dupes > 0 ? 'Another profile with the same phone or e-mail already applied to this job.' : null, flags && flags.length ? `Open flag: ${flags.slice(0, 2).join('; ')}.` : null].filter(Boolean).join(' '));
  else add('duplicate', 'Duplicate / fraud check', 'pass', 'No duplicate or fraud flag.');
  // the match score, optional
  if (useFit) {
    const fit = match ? match.overall : null;
    const min = requirement.minFit || 60;
    if (fit == null) add('fit', 'Match score', 'na', 'No match score.');
    else if (fit >= min) add('fit', 'Match score', 'pass', `Fit ${fit}%.`);
    else add('fit', 'Match score', 'review', `Fit ${fit}% is below ${min}%.`); // never "not suitable" on the score alone
  }
  return out;
}
function verdictOf(checks) {
  const live = checks.filter((c) => c.state !== 'na');
  const result = live.some((c) => c.state === 'fail') ? RESULTS.notsuitable : live.some((c) => c.state === 'review') ? RESULTS.review : RESULTS.pass;
  const score = live.length ? Math.round((live.reduce((n, c) => n + (c.state === 'pass' ? 1 : c.state === 'review' ? 0.5 : 0), 0) / live.length) * 100) : null;
  const reasons = (result === RESULTS.pass ? live : live.filter((c) => c.state !== 'pass')).map((c) => `${c.label}: ${c.why}`);
  return { result, score, reasons };
}

// ---- screen one application ------------------------------------------------------------------------------------------------
async function screen(applicationId, { force = false, actor = null } = {}) {
  await ensure();
  const app = await prisma.application.findUnique({ where: { id: applicationId }, include: { candidate: true, requirement: true } });
  if (!app || !app.requirement || !app.candidate) return null;
  const setting = await jobSetting(app.requirementId);
  if (!setting.enabled && !force) return null;
  const { computeMatch } = require('./matching'); // eslint-disable-line global-require
  const SF = require('./salaryFit'); // eslint-disable-line global-require
  let match = null;
  try { match = computeMatch(app.candidate, app.requirement); } catch { match = null; }
  let salary = null;
  try { salary = SF.fitFor(app.candidate, app.requirement); } catch { salary = null; }
  let knock = null;
  try { knock = (await require('./mktb/jobs').answersFor([app.id])).get(app.id) || null; } catch { knock = null; } // eslint-disable-line global-require
  // the same phone / e-mail on another candidate record on this job
  const c = app.candidate;
  const ph = String(c.phone || '').replace(/\D/g, '').slice(-10);
  const em = String(c.email || '').trim().toLowerCase();
  let dupes = 0;
  if (ph.length === 10 || em) {
    const others = await prisma.application.findMany({ where: { requirementId: app.requirementId, id: { not: app.id }, candidateId: { not: c.id } }, select: { candidate: { select: { phone: true, email: true } } }, take: 3000 });
    dupes = others.filter((o) => (ph.length === 10 && String(o.candidate.phone || '').replace(/\D/g, '').slice(-10) === ph) || (em && String(o.candidate.email || '').trim().toLowerCase() === em)).length;
  }
  let flags = [];
  try { flags = (await prisma.$queryRawUnsafe('SELECT "kind" FROM "MktFraudFlag" WHERE "status" = \'Open\' AND ("candidateId" = ? OR "otherCandidateId" = ?) LIMIT 5', c.id, c.id)).map((f) => f.kind); } catch { flags = []; }
  const checks = checksFor({ candidate: c, requirement: app.requirement, match, salary, knock, dupes, flags, useFit: setting.useFit });
  const v = verdictOf(checks);
  // act on it only when the job says so
  let acted = null;
  if (setting.enabled && setting.act && EARLY.includes(app.stage)) acted = await actOn(app, v).catch((e) => { console.error('[auto-screen] act:', e.message); return null; }); // eslint-disable-line no-console
  await x('INSERT INTO "AtsScreenResult" ("applicationId","requirementId","candidateId","result","score","reasons","checks","acted","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "result"=excluded."result","score"=excluded."score","reasons"=excluded."reasons","checks"=excluded."checks","acted"=COALESCE(excluded."acted","AtsScreenResult"."acted"),"byName"=excluded."byName","at"=excluded."at"',
    app.id, app.requirementId, app.candidateId, v.result, v.score, JSON.stringify(v.reasons), JSON.stringify(checks), acted, actor ? actor.name : 'Auto-screen', iso());
  return resultOf(app.id);
}
async function actOn(app, v) {
  const G = require('./mktb/gov'); // eslint-disable-line global-require
  const reason = v.reasons.join('; ').slice(0, 480);
  const move = async (toStage, action, kind, aiDecision, extra = {}) => {
    await prisma.application.update({ where: { id: app.id }, data: { stage: toStage } });
    await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: app.candidateId, fromStage: app.stage, toStage, action, comment: reason || null, actorName: 'Auto-screen', actorRole: 'SYSTEM', actorSide: 'Internal', requirementId: app.requirementId, requirementTitle: app.requirement.title, ...extra } });
    await G.addReview({ kind, refType: 'Application', refId: app.id, applicationId: app.id, candidateId: app.candidateId, summary: `${app.candidate.name} (${app.requirement.title}): ${reason || v.result}`, aiDecision, undo: { type: 'stage', applicationId: app.id, fromStage: toStage, toStage: app.stage } }).catch(() => {});
    return `${action}`;
  };
  if (v.result === RESULTS.pass && app.stage === 'NEW') return move('RECRUITER_REVIEW', 'Auto-screen passed: moved to Recruiter check', 'Auto-screen move', 'Moved to Recruiter check');
  if (v.result === RESULTS.notsuitable) {
    if (await autoRejectOn()) return move('REJECTED', 'Rejected by auto-screen (auto-reject rule is on)', 'Auto-reject', 'Rejected', { reasonCategory: 'Auto-screen: not suitable', reasonDetail: reason || null });
    if (app.stage !== 'HOLD') return move('HOLD', 'On hold: auto-screen not suitable', 'Auto-screen hold', 'Put on hold', { reasonCategory: 'Auto-screen: not suitable', reasonDetail: reason || null });
  }
  return null;
}
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
async function resultOf(applicationId) {
  const [r] = await q('SELECT * FROM "AtsScreenResult" WHERE "applicationId" = ?', applicationId);
  if (!r) return null;
  return { applicationId, result: r.result, score: r.score == null ? null : Number(r.score), reasons: parse(r.reasons, []), checks: parse(r.checks, []), acted: r.acted || null, by: r.byName, at: r.at };
}
// for the Candidates list: application id -> { result, score, reasons }
async function attach(rows, idOf = (r) => r.id) {
  try {
    const ids = [...new Set((rows || []).map(idOf).filter(Boolean))];
    if (!ids.length) return;
    const by = new Map();
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      // eslint-disable-next-line no-await-in-loop
      (await q(`SELECT "applicationId", "result", "score", "reasons", "acted" FROM "AtsScreenResult" WHERE "applicationId" IN (${part.map(() => '?').join(',')})`, ...part))
        .forEach((r) => by.set(r.applicationId, { result: r.result, score: r.score == null ? null : Number(r.score), reasons: parse(r.reasons, []).slice(0, 4), acted: r.acted || null }));
    }
    rows.forEach((r) => { const s = by.get(idOf(r)); if (s) r.screening = s; }); // eslint-disable-line no-param-reassign
  } catch { /* no result table yet */ }
}
// the ?screening= filter: 'pass,review,notsuitable,none' -> (applicationId) => bool
async function matcher(csv) {
  const want = String(csv || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => RESULTS[s] || s === 'none');
  if (!want.length) return null;
  const rows = await q('SELECT "applicationId", "result" FROM "AtsScreenResult"').catch(() => []);
  const by = new Map(rows.map((r) => [r.applicationId, r.result]));
  const labels = new Set(want.filter((w) => RESULTS[w]).map((w) => RESULTS[w]));
  const none = want.includes('none');
  return (appId) => (by.has(appId) ? labels.has(by.get(appId)) : none);
}

// ---- the doors ---------------------------------------------------------------------------------------------------------------
// called by the Prisma hook (db.js) after an Application row is created; never throws
async function anyOn() {
  if (Date.now() - CACHE.at < 30000 && CACHE.def !== null) return CACHE.def;
  const s = await settings();
  const [n] = await q('SELECT COUNT(*) AS "n" FROM "AtsAutoScreenJob" WHERE "enabled" = 1').catch(() => [{ n: 0 }]);
  CACHE = { at: Date.now(), def: s.defaultOn || Number(n.n) > 0, jobs: new Map() };
  return CACHE.def;
}
function onNewApplication(applicationId, delayMs = 2500) {
  if (!applicationId) return;
  const t = setTimeout(async () => {
    try {
      if (!(await anyOn())) return;
      const [done] = await q('SELECT "applicationId" FROM "AtsScreenResult" WHERE "applicationId" = ?', applicationId);
      if (!done) await screen(applicationId);
    } catch (err) { console.error('[auto-screen]', err.message); } // eslint-disable-line no-console
  }, delayMs);
  if (t.unref) t.unref();
}
// catches what the hook missed (a bulk import): the last day's new applications on jobs that screen
async function sweep({ now = new Date() } = {}) {
  if (!(await anyOn())) return { screened: 0 };
  const apps = await prisma.application.findMany({ where: { createdAt: { gte: new Date(now.getTime() - 86400000) } }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
  const done = new Set((await q('SELECT "applicationId" FROM "AtsScreenResult" WHERE "at" >= ?', new Date(now.getTime() - 2 * 86400000).toISOString())).map((r) => r.applicationId));
  let n = 0;
  for (const a of apps) {
    if (done.has(a.id)) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    if (await screen(a.id)) n += 1;
  }
  return { screened: n };
}
let TIMER = null;
function startSweep() {
  if (TIMER || require('./sandbox').isSandbox()) return; // eslint-disable-line global-require
  TIMER = setInterval(() => { sweep().catch((e) => console.error('[auto-screen] sweep:', e.message)); }, 10 * 60000); // eslint-disable-line no-console
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  RESULTS, ensure, settings, saveSettings, jobSetting, saveJob, mayEdit, autoRejectOn, expRange, checksFor, verdictOf, screen, resultOf, attach, matcher, onNewApplication, sweep, startSweep, forget,
};
