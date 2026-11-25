// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > AUTOMATIC AUDITS AND ALERTS (2026-11-25). A client's website is audited again by itself, so nobody has to remember:
//   * SCHEDULE  a site set to "every week" or "every month" (Site and schedule) is audited when its next day comes: the same audit as the Audit now button (seoAudit.js: saved, recommendations
//               updated, fixed problems confirmed). At most 3 sites per sweep, one after the other, so the office's own server is never loaded;
//   * ALERTS    a BELL to whoever started the site (the Admins if that person is no longer active), once per audit, when
//                 - the score DROPPED by the site's "alert size" (default 5 points) or more since the audit before,
//                 - a SERIOUS new problem appeared (the site asks search engines to stay away, loses https, is told not to be indexed),
//                 - the website could not be reached twice in a row (after the first miss it is tried again the next day);
//               the same facts are in the progress feed on the dashboard (seoEvents.js), so they are seen even when nobody looks at the bell;
//   * IMPROVEMENTS  a recommendation the audit confirms as fixed is written in the progress feed ("3 recommendations fixed") and counted on the dashboard: no bell for good news.
// A daily job (start(): every 6 hours, never in the sandbox). It reads the client's PUBLIC pages like the Audit now button; nothing is sent outside TeamLink: no email, no WhatsApp, nothing to the client.
// HONEST: a drop or a rise is what TeamLink measured on the pages, not a ranking and not a cause.
// ---------------------------------------------------------------------------
const Sites = require('./seoSites');
const Audit = require('./seoAudit');
const Ev = require('./seoEvents');
const Google = require('./seoGoogle');

const sign = (n) => (n > 0 ? `+${n}` : String(n));
async function recipients(raw) { // whoever started the site, if still active; else the active Admins
  try {
    const prisma = require('../db'); // eslint-disable-line global-require
    if (raw.createdById && raw.createdById !== 'system') { const u = await prisma.user.findFirst({ where: { id: raw.createdById, status: 'Active' }, select: { id: true } }); if (u) return [u.id]; }
    return (await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ['SUPER_ADMIN', 'ADMIN'] } }, { atsRole: { in: ['SUPER_ADMIN', 'ADMIN'] } }] }, select: { id: true }, take: 10 })).map((a) => a.id);
  } catch { return []; }
}

// the words of the bell for one audit result: [{ kind, title, message }] (pure: a test reads it)
function alertsOf(site, r) {
  const out = [];
  if (r.delta != null && r.delta <= -(Number(site.alertDrop) || 5)) out.push({ kind: 'drop', title: `SEO score dropped: ${site.clientName}`, message: `The website score of ${site.clientName} went from ${r.prev} to ${r.score} out of 100 (${sign(r.delta)} points) in the audit just made. Open AI Marketing > SEO assistant to see what changed. This is what TeamLink measured on the pages, not a ranking.`  });
  if (r.tasks && r.tasks.serious && r.tasks.serious.length) out.push({ kind: 'serious', title: `Serious SEO problem: ${site.clientName}`, message: `The audit of ${site.clientName} found: ${r.tasks.serious.slice(0, 3).join('; ')}. Open AI Marketing > SEO assistant > Recommendations.` });
  return out;
}

// opts: { now, notify, recipients, fetchFn (a test answers these), force (run in the sandbox), limit (sites per sweep) }
async function sweep(opts = {}) {
  const out = { due: 0, audited: 0, failed: 0, bells: 0, noRecipient: 0 };
  if (!opts.force && require('../utils/sandbox').isSandbox()) return { ...out, sandbox: true }; // eslint-disable-line global-require
  if (!(await Sites.ensure())) return out;
  const now = opts.now || Date.now(); const notify = opts.notify || require('../utils/notify').notifyUsers; // eslint-disable-line global-require
  const bell = async (raw, a) => { const to = await (opts.recipients || recipients)(raw); if (!to.length) { out.noRecipient += 1; return; } await notify(to, { title: a.title, message: a.message }); out.bells += 1; };
  for (const raw of await Sites.dueSites(now, opts.limit || 3)) {
    out.due += 1; const site = Sites.rowOut(raw);
    // the audit trail needs a real login: the one who started the site (an Admin if that person left); the name on the line says it was a scheduled audit
    let r; try { r = await Audit.run(opts.actor || { ...Audit.SYS, id: (await recipients(raw))[0] || Audit.SYS.id }, raw, { now, fetchFn: opts.fetchFn }); } catch (e) { r = { error: e.message || 'The audit failed.' }; }
    if (r.error) { // not reached: try again tomorrow; tell once after the second miss in a row
      out.failed += 1; const fails = (Number(raw.fails) || 0) + 1; await Sites.setRun(raw.id, { fails, nextRunAt: now + Sites.DAY });
      await Ev.add(raw.id, { kind: 'unreachable', level: fails >= 2 ? 'bad' : 'warn', at: now, title: `The website could not be audited${fails > 1 ? ` (${fails} times in a row)` : ''}`, message: r.error });
      if (fails === 2) await bell(raw, { title: `Website could not be reached: ${site.clientName}`, message: `The scheduled SEO audit of ${site.clientName} (${site.url}) failed twice in a row: ${r.error} Check that the website is up. It is tried again every day.` });
      continue;
    }
    out.audited += 1;
    for (const a of alertsOf(site, r)) { await bell(raw, a); await Ev.add(raw.id, { kind: a.kind, level: a.kind === 'serious' ? 'bad' : 'warn', at: now, title: a.title.replace(/: .*$/, ''), message: a.message.slice(0, 500) }); }
    // phase 2: the same visit reads Google (Search Console queries and totals, Analytics) for a site that has a property; a failure there never undoes the audit, and a fall in search clicks rings a bell
    if (site.gscProperty || site.ga4Property) {
      try {
        const g = await Google.syncSite(opts.actor || { ...Audit.SYS, id: (await recipients(raw))[0] || Audit.SYS.id }, raw, 'both', { now, fetchFn: opts.googleFetch, key: opts.googleKey });
        out.google = (out.google || 0) + 1;
        for (const e of g.errors) await Ev.add(raw.id, { kind: 'google', level: 'warn', at: now, title: `Google ${e.api === 'gsc' ? 'Search Console' : 'Analytics'} could not be read`, message: e.error.slice(0, 500) });
        for (const a of Google.alertsOf(site.clientName, g.gsc)) { await bell(raw, a); await Ev.add(raw.id, { kind: a.kind, level: 'warn', at: now, title: a.title.replace(/: .*$/, ''), message: a.message.slice(0, 500) }); }
      } catch { /* Google is optional: the audit above is already saved */ }
    }
  }
  return out;
}
let timer = null;
function start() {
  if (timer || require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  setTimeout(() => sweep().catch(() => {}), 150 * 1000).unref();
  timer = setInterval(() => { sweep().catch(() => {}); }, 6 * 3600 * 1000); if (timer.unref) timer.unref();
}
module.exports = { sweep, start, alertsOf, recipients };
