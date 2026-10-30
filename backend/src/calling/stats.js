// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE DASHBOARD NUMBERS.
// Counts are over the calls the signed-in person may see (their own scope), with the filters date / requirement / recruiter /
// campaign / purpose / status. Test calls and live calls are kept apart (mode filter, default: live).
// ---------------------------------------------------------------------------
const S = require('./scripts');
const DB = require('./schema');
const svc = require('./callService');

async function dashboard(user, q = {}) {
  const r = await svc.list(user, { ...q, limit: 500, mode: q.mode || 'live' });
  if (!r.ok) return r;
  const rows = r.rows;
  const count = (f) => rows.filter(f).length;
  const dur = rows.filter((x) => x.durationSec > 0).map((x) => x.durationSec);
  const byPurpose = {}; const byDay = {}; const byCampaign = {};
  rows.forEach((x) => {
    byPurpose[x.purpose] = (byPurpose[x.purpose] || 0) + 1;
    const day = String(x.createdAt || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (x.campaignId) {
      const c = byCampaign[x.campaignId] || (byCampaign[x.campaignId] = { total: 0, completed: 0, interested: 0 });
      c.total += 1; if (x.status === 'completed') c.completed += 1; if (x.outcome === 'Interested') c.interested += 1;
    }
  });
  let campaigns = [];
  const ids = Object.keys(byCampaign);
  if (ids.length) {
    const named = await DB.all(`SELECT "id","name" FROM "AiCallCampaign" WHERE "id" IN (${ids.map(() => '?').join(',')})`, ...ids);
    campaigns = named.map((n) => ({ id: n.id, name: n.name, ...byCampaign[n.id] }));
  }
  return {
    ok: true,
    totals: {
      total: rows.length,
      connected: count((x) => x.status === 'completed'),
      failed: count((x) => x.status === 'failed'),
      busy: count((x) => x.status === 'busy'),
      noAnswer: count((x) => x.status === 'no-answer'),
      queued: count((x) => x.status === 'queued'),
      calling: count((x) => x.status === 'calling'),
      cancelled: count((x) => x.status === 'cancelled'),
      interested: count((x) => S.screenLike(x.purpose) && x.outcome === 'Interested'),
      notInterested: count((x) => S.screenLike(x.purpose) && x.outcome === 'Not Interested'),
      callbackRequests: count((x) => x.outcome === 'Call Back Later' || /call the candidate back/i.test(x.nextAction || '')),
      shortlistCalls: count((x) => x.purpose === 'Shortlist Notification'),
      shortlistInterested: count((x) => x.purpose === 'Shortlist Notification' && x.outcome === 'Interested'),
      interviewConfirmed: count((x) => /^Interview/.test(x.purpose) && x.outcome === 'Confirmed'),
      rescheduleRequests: count((x) => /^Interview/.test(x.purpose) && x.outcome === 'Reschedule Requested'),
      totalSeconds: dur.reduce((a, b) => a + b, 0),
      averageSeconds: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) : 0,
    },
    byPurpose,
    byDay,
    campaigns,
    note: rows.length >= 500 ? 'Showing the latest 500 calls.' : null,
  };
}

module.exports = { dashboard };
