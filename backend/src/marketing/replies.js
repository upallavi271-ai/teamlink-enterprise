// ---------------------------------------------------------------------------
// AI MARKETING > CLIENT REPLIES (2026-11-16, founder: simple like Green Start): ONE list of what CLIENTS said or decided, newest first, so nobody hunts for it in three places:
//   * a client-approval link they answered (Approved / asked for changes, with their comment)
//   * a client project: they chose an option, asked for changes, or wrote on WhatsApp (the simple automatic reply is shown in the project's own timeline)
// Read only: it shows what each login may already see (the same visibility as Client projects and the approvals). Nothing is sent or changed here.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

const DAY = 86400000;
const ANSWER = { client_chose: 'Chose an option', client_changes: 'Asked for changes', client_msg: 'Wrote on WhatsApp' };

// -> { replies: [{ id, at, kind: 'review' | 'project', client, who, what, answer, tone: 'good' | 'warn' | 'info', text, page, open? }] }
async function list(u, { days = 60, limit = 120 } = {}) {
  const since = Date.now() - Math.max(1, Math.min(365, Number(days) || 60)) * DAY;
  const replies = [];
  try {
    const CR = require('./clientReview'); // eslint-disable-line global-require
    ((await CR.list(u, {})).reviews || []).forEach((r) => {
      if (!['approved', 'changes'].includes(r.status) || !(Date.parse(r.decidedAt) >= since)) return;
      replies.push({ id: `rv${r.id}`, at: r.decidedAt, kind: 'review', client: r.clientName, who: r.decidedByName || r.contactName || '', what: r.itemTitle, answer: r.status === 'approved' ? 'Approved' : 'Asked for changes', tone: r.status === 'approved' ? 'good' : 'warn', text: r.comment || '', page: 'mkapprove' });
    });
  } catch (e) { console.error('[omni-mk] replies reviews:', e.message); } // eslint-disable-line no-console
  try {
    const P = require('./projects'); // eslint-disable-line global-require
    const got = await P.list(u, {});
    const projects = got.projects || [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    const ids = projects.map((p) => p.id).slice(0, 400);
    if (ids.length) {
      const rows = await S.q(`SELECT id, projectId, at, kind, byName, text FROM "OmniMkProjectEvent" WHERE kind IN ('client_chose','client_changes','client_msg') AND at >= ? AND projectId IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC LIMIT 500`, since, ...ids);
      rows.forEach((e) => {
        const p = byId.get(e.projectId); if (!p) return;
        replies.push({ id: `pe${e.id}`, at: S.iso(e.at), kind: 'project', client: p.clientName, who: e.byName || p.contactName || '', what: p.occasion || p.title, answer: ANSWER[e.kind], tone: e.kind === 'client_chose' ? 'good' : (e.kind === 'client_changes' ? 'warn' : 'info'), text: e.text || '', page: 'mkprojects', open: p.id });
      });
    }
  } catch (e) { console.error('[omni-mk] replies projects:', e.message); } // eslint-disable-line no-console
  replies.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { replies: replies.slice(0, Math.max(1, Math.min(300, Number(limit) || 120))) };
}

module.exports = { list };
