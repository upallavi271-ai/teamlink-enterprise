// ---------------------------------------------------------------------------
// THE TEAM PAGE IN A PERIOD (founder 2026-11-20: "Recruiters, TLs: every one must have filters. Date filters too.").
//
//   GET /api/ats/team/period?range=this_month|last_month|this_quarter|this_year|custom&from=&to=
//   -> { range: { key, from, to, label }, rows: { <personId>: { joined, target, pct, band, sent, interviews, ... } }, months }
//
// THE NUMBERS follow the same rules as the rest of the ATS:
//   joined      the joinings CREDITED to the person (utils/recruiterJoinings.js monthBoard: counted joinings only - a person
//               who dropped, or who is not counted by utils/joinedRule.js, is not in it), with the joining day inside the range
//   target      the person's monthly target (utils/recruiterJoinings.js targetOf) added up for every month the range touches
//   pct, band   joined against that target; band = the same tone words as the Recruiter joinings board (toneOf)
//   sent        applications first sent to the client inside the range, credited to the recruiter who had the person at that
//               moment (utils/workers.js creditAt - the same credit as the Team page's own numbers)
//   interviews  interviews booked for a day inside the range (cancelled / no-show left out), credited the same way
// WHO SEES WHO: only the people the Team page already lists for this login (a recruiter: themselves; a TL: their team; a
// Manager / Admin: everyone) - the rows are cut to that list before anything is returned.
// ---------------------------------------------------------------------------
const RJ = require('./recruiterJoinings');
const TW = require('./teamWorkload');
const dateRange = require('./dateRange');

const MAX_MONTHS = 24;
const PRESET_KEYS = ['this_month', 'last_month', 'this_quarter', 'this_year', 'custom'];

function monthsIn(from, to) {
  const out = [];
  for (let m = to.slice(0, 7); m >= from.slice(0, 7) && out.length < MAX_MONTHS; m = RJ.prevMonth(m)) out.push(m);
  return out;
}
const pctOf = (joined, target) => (target > 0 ? Math.round((joined / target) * 100) : null);
const achBand = (pct) => (pct === null ? 'none' : pct >= 100 ? 'met' : pct >= 50 ? 'half' : 'below');
const ACH_LABELS = { none: 'No target', below: 'Under 50% of target', half: '50% to 99% of target', met: 'Target met' };

async function teamPeriod(user, query = {}) {
  const key = PRESET_KEYS.includes(query.range) ? query.range : (query.from || query.to ? 'custom' : 'this_month');
  const r = dateRange.resolve({ range: key, from: query.from, to: query.to });
  const { from, to } = r;
  const months = monthsIn(from, to);
  // the people the Team page lists for this login
  const own = require('./ownOnly').isOwnOnly(user); // eslint-disable-line global-require
  const flags = require('./clientRedact').privacyFlagsFor(user); // eslint-disable-line global-require
  const listed = await TW.teamWorkloadRows(user, { includeLeft: true });
  let people = (listed.rows || []).filter((p) => !flags || !flags.bde || p.roleGroup === 'BDE');
  if (own) people = people.filter((p) => p.id === user.id);
  const ids = new Set(people.map((p) => p.id));
  const rows = {};
  people.forEach((p) => { rows[p.id] = { joined: 0, target: 0, pct: null, band: null, bandWord: null, achBand: 'none', sent: 0, interviews: 0, joiningMonths: 0 }; });

  // joined + target, month by month, from the joinings board (counted joinings only)
  const level = RJ.viewerLevel(user);
  for (const m of months) {
    // eslint-disable-next-line no-await-in-loop
    const board = await RJ.monthBoard(m, { lite: true });
    RJ.rowsForViewer(user, board.rows || board, level).forEach((b) => {
      if (b.kind === 'BDE' || !b.userId || !ids.has(b.userId)) return;
      const row = rows[b.userId];
      row.target += Number(b.target) || 0;
      row.joiningMonths += 1;
      (b.joiningList || []).forEach((a) => { if (a.joiningDate && a.joiningDate >= from && a.joiningDate <= to) row.joined += 1; });
    });
  }
  // sent to the client and interviews in the range
  const act = await TW.periodActivity(user, { from, to });
  Object.keys(rows).forEach((id) => {
    const x = rows[id];
    x.sent = act.sent.get(id) || 0;
    x.interviews = act.interviews.get(id) || 0;
    x.pct = pctOf(x.joined, x.target);
    x.achBand = achBand(x.pct);
    const tone = RJ.toneOf(x.joined, x.target);
    x.band = tone;
    x.bandWord = RJ.TONE_WORD[tone] || null;
  });
  return {
    range: { key: r.key, from, to, label: r.label }, rows, months: months.length, achLabels: ACH_LABELS,
  };
}

module.exports = { teamPeriod, PRESET_KEYS, achBand, ACH_LABELS };
