// ---------------------------------------------------------------------------
// WARM THE CANDIDATE LIST RIGHT AFTER THE SERVER STARTS (spec rule 7: "a page
// opens in about 2 seconds").
//
// The Candidates list and the Progress board read in-memory copies of every
// candidate, application, requirement and follow-up (utils/candidateListCache.js)
// plus a few company-wide indexes (next-action context, last contact,
// rejections, qualification names). They are built on first use — and after a
// restart that first use was a 20-50 s wait for whoever opened the page.
//
// So index.js calls start() once the API is listening: the same functions the
// list calls are called here, in the background, without blocking anything.
// Nothing is computed differently — a request that arrives meanwhile simply
// joins the build already running (each of those functions shares one load
// between concurrent callers). Finally the rows are built once for a Super
// Admin, so the code that shapes them is already compiled when a person asks.
//
// Off in the TEST SANDBOX unless CANDIDATE_WARMUP=1 (to measure it there);
// CANDIDATE_WARMUP=0 switches it off everywhere.
// ---------------------------------------------------------------------------
/* eslint-disable global-require */
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim());
const TEST_LOGIN = /zztest|example\.test/i;

async function warm() {
  // The ATS dashboard is the first page after login: let its own warm-up
  // (utils/atsHome.js) finish first, so the two do not fight for the CPU.
  try { await require('./atsHome').warmCompanyWorld(); } catch { /* its own log */ }
  const t0 = Date.now();
  const cache = require('./candidateListCache');
  const na = require('./nextAction');
  const FV = require('./followupVisibility');
  await Promise.all([
    cache.getListState(),
    na.ensureNextActionContext().then((snap) => FV.contactIndex(snap.stamp)),
    FV.loadRules(),
    require('./rejections').index(),
    require('./specialisations').labelsFor(),
  ]);
  const caches = Date.now() - t0;
  // One build of the pipeline rows for a real Super Admin (all rows, no scope).
  const prisma = require('../db');
  const sa = (await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', status: 'Active' }, select: { id: true, name: true, email: true }, take: 20,
  })).find((u) => !TEST_LOGIN.test(`${u.name} ${u.email}`));
  if (sa) {
    const user = await require('./identity').resolveIdentity(sa.id);
    if (user) await require('../routes/candidates').pipelineRowsFor(user);
  }
  // eslint-disable-next-line no-console
  console.log(`[warmup] candidate list ready in ${((Date.now() - t0) / 1000).toFixed(1)} s (data ${(caches / 1000).toFixed(1)} s)`);
}

function start() {
  const flag = process.env.CANDIDATE_WARMUP;
  if (falsy(flag)) return;
  if (require('./sandbox').isSandbox() && !truthy(flag)) return;
  const delay = Number(process.env.CANDIDATE_WARMUP_DELAY_MS);
  const t = setTimeout(() => {
    warm().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[warmup] candidate list warm-up failed:', err.message);
    });
  }, Number.isFinite(delay) && delay >= 0 ? delay : 500);
  if (t.unref) t.unref();
}

module.exports = { start, warm };
