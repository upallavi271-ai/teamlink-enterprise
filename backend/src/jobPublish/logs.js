// ---------------------------------------------------------------------------
// JOB PUBLISHING: PostingLog rows. One row per step of a run. NEVER a secret: every message goes through scrub().
// ---------------------------------------------------------------------------
const { q, ex, newId, iso } = require('./db');

const MAX_MESSAGE = 600;

// Remove anything that looks like a credential. `secrets` = the exact values this run holds (username, password ...).
function scrub(text, secrets = []) {
  let t = String(text == null ? '' : text);
  secrets.filter((s) => s && String(s).length >= 3).forEach((s) => { t = t.split(String(s)).join('***'); });
  t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  t = t.replace(/(password|passwd|pwd|secret|token|otp|api[_-]?key)\s*[=:]\s*[^\s,;&"']+/gi, '$1=***');
  return t;
}

async function write({ queueId = null, requirementId = null, portal, step, level = 'INFO', message, screenshotPath = null, durationMs = null, secrets = [] }) {
  try {
    const msg = scrub(message, secrets).slice(0, MAX_MESSAGE);
    await ex(
      'INSERT INTO "PostingLog" ("id","queueId","requirementId","portal","step","level","message","screenshotPath","durationMs","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
      newId('pl'), queueId, requirementId, portal, String(step).slice(0, 60), level, msg, screenshotPath, durationMs == null ? null : Math.round(durationMs), Date.now(),
    );
  } catch (err) {
    // Keeping a log is never fatal.
    console.error(`[job-publish] could not write a log row: ${String(err && err.message).slice(0, 120)}`); // eslint-disable-line no-console
  }
}

// Filters: queueId, requirementId, portal, level, requirementIds (scope), from, to, page, pageSize
async function list(f = {}) {
  const where = []; const p = [];
  if (f.queueId) { where.push('l."queueId" = ?'); p.push(f.queueId); }
  if (f.requirementId) { where.push('l."requirementId" = ?'); p.push(f.requirementId); }
  if (f.portal) { where.push('l."portal" = ?'); p.push(f.portal); }
  if (f.level) { where.push('l."level" = ?'); p.push(f.level); }
  if (f.from) { where.push('l."createdAt" >= ?'); p.push(f.from); }
  if (f.to) { where.push('l."createdAt" <= ?'); p.push(f.to); }
  if (Array.isArray(f.requirementIds)) {
    if (!f.requirementIds.length) return { rows: [], total: 0, page: 1, pageSize: f.pageSize || 50 };
    where.push(`l."requirementId" IN (${f.requirementIds.map(() => '?').join(',')})`); p.push(...f.requirementIds);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));
  const page = Math.max(1, Number(f.page) || 1);
  const total = ((await q(`SELECT COUNT(*) n FROM "PostingLog" l ${w}`, ...p))[0] || {}).n || 0;
  const rows = await q(
    `SELECT l.* FROM "PostingLog" l ${w} ORDER BY l."createdAt" DESC, l."id" DESC LIMIT ? OFFSET ?`,
    ...p, pageSize, (page - 1) * pageSize,
  );
  return {
    total, page, pageSize,
    rows: rows.map((r) => ({
      id: r.id, queueId: r.queueId, requirementId: r.requirementId, portal: r.portal, step: r.step, level: r.level, message: r.message,
      hasScreenshot: !!r.screenshotPath, fileKind: r.screenshotPath ? (String(r.screenshotPath).toLowerCase().endsWith('.txt') ? 'structure' : 'image') : null, durationMs: r.durationMs, at: iso(r.createdAt),
    })),
  };
}

module.exports = { write, list, scrub };
