// ---------------------------------------------------------------------------
// ATS Reports → "Added by override" (B8, 2026-10-05).
//
// Every application where someone added a person who did NOT meet the job's
// rules (must-have skills, minimum Fit, notice, location) and gave a reason
// (routes/applications.js POST, Application.override*). Same filters, scope,
// drill-downs and export as every other ATS report (routes/atsReports.js),
// because it is built on the report's own scoped application list.
//
// Factory like utils/reportsPlus.js: atsReports.js passes its helpers in.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const dateRange = require('./dateRange');

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const RULES = [
  ['fit', 'Fit below the minimum', /below/i],
  ['skills', 'Missing a must-have skill', /must-have|mandatory/i],
  ['location', 'Location does not match', /location/i],
  ['notice', 'Notice period too long', /notice/i],
];
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');

module.exports = function fitReports({
  Cell, section, addTotal, tileSet, pct,
}) {
  // The override rows (a few hundred at most), with the candidate's name.
  async function prepareOverrides(ctx) {
    ctx.overrides = new Map();
    let rows = [];
    try {
      rows = await prisma.application.findMany({
        where: { overrideAt: { not: null } },
        select: {
          id: true, overrideReason: true, overrideByName: true, overrideAt: true, matchScore: true, matchVersion: true, matchDetail: true,
          candidate: { select: { name: true } },
        },
      });
    } catch { ctx.overridesNotReady = true; }
    rows.forEach((r) => ctx.overrides.set(r.id, r));
  }

  function buildOverrides(ctx) {
    let list = ctx.apps.filter((x) => ctx.overrides && ctx.overrides.has(x.id));
    if (ctx.f.period) {
      const within = dateRange.dateTimeIn(ctx.f.period);
      list = list.filter((x) => { const at = ctx.overrides.get(x.id).overrideAt; return at >= within.gte && at < within.lt; });
    }
    const t = tileSet();
    const all = t.add('overrides', 'Added by override', 'app', 'People added although they did not meet the job\'s rules');
    const going = t.add('going', 'Still in process', 'app');
    const selected = t.add('selected', 'Selected (incl. joined)', 'app');
    const joined = t.add('joined', 'Joined', 'app');
    const rejected = t.add('rejected', 'Rejected later', 'app');

    const every = section('overrideList', 'Every override', [
      { key: 'candidate', label: 'Candidate', ref: 'cand' },
      { key: 'job', label: 'Job', ref: 'req' },
      { key: 'client', label: 'Client', ref: 'client' },
      { key: 'reason', label: 'Reason given' },
      { key: 'failed', label: 'Did not meet' },
      { key: 'fit', label: 'Fit %', type: 'num' },
      { key: 'version', label: 'Fit version' },
      { key: 'by', label: 'Added by' },
      { key: 'on', label: 'Date' },
      { key: 'step', label: 'Step now' },
      { key: 'n', label: 'Open', drill: 'app' },
    ], { paged: true, sort: (a, b) => String(b.cells.on).localeCompare(String(a.cells.on)) });
    const byPerson = section('overrideBy', 'By the person who added', [
      { key: 'by', label: 'Added by' },
      { key: 'count', label: 'Overrides', drill: 'app' },
      { key: 'joined', label: 'Joined', drill: 'app' },
      { key: 'rejected', label: 'Rejected later', drill: 'app' },
      { key: 'joinPct', label: 'Joined %', type: 'pct' },
    ], { sort: (a, b) => b.cells.count.n - a.cells.count.n });
    const byRule = section('overrideRule', 'Which rule was not met', [
      { key: 'rule', label: 'Rule' },
      { key: 'count', label: 'Overrides', drill: 'app' },
      { key: 'joined', label: 'Joined', drill: 'app' },
    ], { sort: (a, b) => b.cells.count.n - a.cells.count.n, sub: 'One person can miss more than one rule.' });

    list.forEach((x) => {
      const o = ctx.overrides.get(x.id);
      const d = safeParse(o.matchDetail) || {};
      const why = Array.isArray(d.notEligibleBecause) ? d.notEligibleBecause.filter((w) => !/lists no must-have/.test(w)) : [];
      all.add(x.id);
      if (x.inPipeline) going.add(x.id);
      if (x.reached('selected') || x.joined) selected.add(x.id);
      if (x.joined) joined.add(x.id);
      if (x.stage === 'REJECTED') rejected.add(x.id);
      const r = every.row(x.id);
      r.refs = { cand: x.a.candidateId, req: x.req.id, ...(x.req.internal ? {} : { client: x.req.clientId }) };
      Object.assign(r.cells, {
        candidate: (o.candidate && o.candidate.name) || '—',
        job: x.req.title || '—',
        client: x.req.clientName,
        reason: o.overrideReason || '—',
        failed: why.join('; ') || '—',
        fit: (d.listView && d.listView.overall != null) ? d.listView.overall : o.matchScore,
        version: o.matchVersion ? o.matchVersion.replace(/^fit-/, '') : 'v1',
        by: o.overrideByName || '—',
        on: day(o.overrideAt),
        step: x.pipe.label,
      });
      r.cells.n.add(x.id);
      const p = byPerson.row(o.overrideByName || '—');
      p.cells.by = o.overrideByName || '—';
      p.cells.count.add(x.id);
      if (x.joined) p.cells.joined.add(x.id);
      if (x.stage === 'REJECTED') p.cells.rejected.add(x.id);
      RULES.forEach(([k, label, re]) => {
        if (!why.some((w) => re.test(w))) return;
        const rr = byRule.row(k);
        rr.cells.rule = label;
        rr.cells.count.add(x.id);
        if (x.joined) rr.cells.joined.add(x.id);
      });
    });
    byPerson.rows.forEach((r) => { r.cells.joinPct = pct(r.cells.joined.n, r.cells.count.n); });
    addTotal(byPerson, (c) => { c.joinPct = pct(c.joined.n, c.count.n); });
    addTotal(byRule);

    const notes = [];
    if (ctx.overridesNotReady) notes.push('This report is being set up. Please try again later.');
    else if (!list.length) notes.push('No one was added by override in this scope and date range.');
    else {
      const jp = pct(joined.n, all.n);
      notes.push(`${all.n} ${all.n === 1 ? 'person was' : 'people were'} added although they did not meet the job's rules; ${joined.n} joined (${jp}%).`);
    }
    return {
      tiles: t.tiles, sections: [byRule, byPerson, every], notes, plain: true,
    };
  }

  return { prepareOverrides, buildOverrides, Cell };
};
