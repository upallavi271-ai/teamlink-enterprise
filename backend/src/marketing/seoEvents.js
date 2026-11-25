// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > EVENTS (2026-11-25). The progress feed of a site: "score 62 to 71", "5 recommendations fixed (confirmed by the audit)", "score dropped 8 points", "robots.txt now blocks the site".
// Written by the audit runner (seoAudit.js), the tasks (seoTasks.js) and the scheduler (seoSchedule.js); read by the dashboard. Plain facts of what TeamLink measured: no cause is claimed.
// saved: table OmniMkSeoEvent (kept as long as the site exists).
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

const T = 'OmniMkSeoEvent';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "siteId" TEXT NOT NULL, "kind" TEXT NOT NULL, "level" TEXT NOT NULL DEFAULT 'info', "title" TEXT NOT NULL, "message" TEXT, "at" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_site" ON "${T}"("siteId", "at")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo event schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

// level: 'good' (an improvement), 'info', 'warn' (something to look at), 'bad' (a serious problem). NEVER throws: a lost line must not break an audit.
async function add(siteId, { kind, level = 'info', title, message = '', at }) {
  try { if (!(await ensure()) || !siteId || !title) return null; const id = S.newId('sev'); await S.run(`INSERT INTO "${T}" (id, siteId, kind, level, title, message, at) VALUES (?,?,?,?,?,?,?)`, id, siteId, S.clip(kind, 30), ['good', 'info', 'warn', 'bad'].includes(level) ? level : 'info', S.clip(title, 200), S.clip(message, 600), at || Date.now()); return id; } catch { return null; }
}
async function recent(siteId, limit = 15) {
  if (!(await ensure())) return [];
  return (await S.q(`SELECT * FROM "${T}" WHERE siteId = ? ORDER BY at DESC LIMIT ?`, siteId, Math.max(1, Math.min(100, limit)))).map((r) => ({ id: r.id, kind: r.kind, level: r.level, title: r.title, message: r.message || '', at: S.iso(r.at) }));
}
module.exports = { ensure, add, recent };
