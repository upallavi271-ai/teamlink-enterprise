// ---------------------------------------------------------------------------
// CUSTOM REPORT BUILDER + "ASK FOR A CHART" (12.02 / 01.12 / 01.15, 2026-11-21).
//
// ONE SMALL QUERY LANGUAGE, BUILT IN CODE. A report is a plain JSON spec:
//   { entity, columns: [field], filters: [{ field, op, value }], range, groupBy, measure: { op, field }, chart, sort, limit }
// Every name in it must be on the whitelist below (ENTITIES); anything else is dropped by clean(). The rows come from the
// SAME scoped report context every ATS report uses (core.ctxFor), so a saved report shared with the team runs in each
// viewer's OWN scope - nobody sees a row they could not see in Reports.
//
// The AI never writes a query. For "ask for a chart" the model is given the question (phone numbers / e-mails masked)
// and the field list, and may only answer with a spec; the spec goes through the same clean() as a hand-built one. When
// no AI answers, a plain keyword reader (parseQuestion) builds the spec in code.
//
// No candidate phone, e-mail, salary or ID is a column here at all (the BDE rule), and no money column exists.
// ---------------------------------------------------------------------------
const C = require('./core');
const M = require('./metrics');

const STAGE_TEXT = (x) => (x.pipe && x.pipe.label) || x.a.stage;
const month = (d) => (d ? String(d).slice(0, 7) : null);
const ENTITIES = {
  applications: {
    label: 'Candidates on requirements',
    fields: {
      candidate: { label: 'Candidate', type: 'text', get: (x, n) => n.get(x.a.candidateId) || '—' },
      requirement: { label: 'Requirement', type: 'text', get: (x) => M.reqLabel(x.req) },
      client: { label: 'Client', type: 'text', get: (x) => x.req.clientName },
      department: { label: 'Department', type: 'text', get: (x) => x.req.department || '—' },
      stage: { label: 'Step', type: 'text', get: STAGE_TEXT },
      source: { label: 'Source', type: 'text', get: (x) => x.source || '—' },
      recruiter: { label: 'Recruiter', type: 'text', get: (x) => (x.recruiter && x.recruiter.label) || '—' },
      tl: { label: 'Team lead', type: 'text', get: (x) => (x.tl && x.tl.label) || '—' },
      bde: { label: 'Client manager (BDE)', type: 'text', get: (x) => (x.bde && x.bde.label) || '—' },
      addedOn: { label: 'Added on', type: 'date', get: (x) => C.istDay(x.a.createdAt) },
      addedMonth: { label: 'Month added', type: 'month', get: (x) => month(C.istDay(x.a.createdAt)) },
      interviewOn: { label: 'Interview date', type: 'date', get: (x) => C.istDay(x.a.interviewAt) },
      offerStatus: { label: 'Offer', type: 'text', get: (x) => x.a.offerStatus || '—' },
      joiningStatus: { label: 'Joining', type: 'text', get: (x) => x.a.joiningStatus || '—' },
      joined: { label: 'Joined', type: 'text', get: (x) => (x.joined ? 'Yes' : 'No') },
      daysInStage: { label: 'Days in this step', type: 'num', get: (x) => x.daysInStage || 0 },
    },
    dateField: 'addedOn',
    rows: (ctx) => ctx.apps,
  },
  requirements: {
    label: 'Requirements',
    fields: {
      requirement: { label: 'Requirement', type: 'text', get: (r) => M.reqLabel(r) },
      client: { label: 'Client', type: 'text', get: (r) => r.clientName },
      department: { label: 'Department', type: 'text', get: (r) => r.department || '—' },
      status: { label: 'Status', type: 'text', get: (r) => (M.LIVE.includes(r.status) ? 'Open' : r.status === 'CLOSED' ? 'Closed' : r.status === 'ON_HOLD' ? 'On hold' : 'Not live yet') },
      location: { label: 'Location', type: 'text', get: (r) => r.location || '—' },
      recruiter: { label: 'Recruiter', type: 'text', get: (r) => (r.recruiter && r.recruiter.label) || '—' },
      tl: { label: 'Team lead', type: 'text', get: (r) => (r.tl && r.tl.label) || '—' },
      bde: { label: 'Client manager (BDE)', type: 'text', get: (r) => (r.bde && r.bde.label) || '—' },
      openings: { label: 'Openings', type: 'num', get: (r) => Number(r.openings) || 1 },
      candidates: { label: 'Candidates', type: 'num', get: (r, n, s) => (s.per.get(r.id) || {}).all || 0 },
      sentToClient: { label: 'Sent to client', type: 'num', get: (r, n, s) => (s.per.get(r.id) || {}).shared || 0 },
      filled: { label: 'Joined', type: 'num', get: (r, n, s) => (s.per.get(r.id) || {}).joined || 0 },
      ageDays: { label: 'Days open', type: 'num', get: (r) => r.ageDays },
      addedOn: { label: 'Added on', type: 'date', get: (r) => C.istDay(r.createdAt) },
      addedMonth: { label: 'Month added', type: 'month', get: (r) => month(C.istDay(r.createdAt)) },
    },
    dateField: 'addedOn',
    rows: (ctx) => ctx.reqs,
    prep: (ctx) => {
      const per = new Map();
      ctx.apps.forEach((x) => {
        const p = per.get(x.req.id) || { all: 0, shared: 0, joined: 0 };
        p.all += 1; if (x.reached('shared')) p.shared += 1; if (x.joined) p.joined += 1;
        per.set(x.req.id, p);
      });
      return { per };
    },
  },
  joinings: {
    label: 'Joinings',
    fields: {
      candidate: { label: 'Candidate', type: 'text', get: (x, n) => n.get(x.a.candidateId) || '—' },
      requirement: { label: 'Requirement', type: 'text', get: (x) => M.reqLabel(x.req) },
      client: { label: 'Client', type: 'text', get: (x) => x.req.clientName },
      department: { label: 'Department', type: 'text', get: (x) => x.req.department || '—' },
      recruiter: { label: 'Recruiter', type: 'text', get: (x) => (x.recruiter && x.recruiter.label) || '—' },
      source: { label: 'Source', type: 'text', get: (x) => x.source || '—' },
      joinedOn: { label: 'Joined on', type: 'date', get: (x) => C.joinDayOf(x) },
      joinedMonth: { label: 'Month joined', type: 'month', get: (x) => month(C.joinDayOf(x)) },
      daysToFill: { label: 'Days to fill', type: 'num', get: (x) => { const d = C.joinDayOf(x); return d ? Math.max(0, C.dayDiff(C.istDay(x.req.createdAt), d)) : null; } },
      daysToHire: { label: 'Days to hire', type: 'num', get: (x) => { const d = C.joinDayOf(x); return d ? Math.max(0, C.dayDiff(C.istDay(x.a.createdAt), d)) : null; } },
    },
    dateField: 'joinedOn',
    rows: (ctx) => ctx.apps.filter((x) => x.joined),
  },
  interviews: {
    label: 'Interviews',
    fields: {
      candidate: { label: 'Candidate', type: 'text', get: (x, n) => n.get(x.a.candidateId) || '—' },
      requirement: { label: 'Requirement', type: 'text', get: (x) => M.reqLabel(x.req) },
      client: { label: 'Client', type: 'text', get: (x) => x.req.clientName },
      department: { label: 'Department', type: 'text', get: (x) => x.req.department || '—' },
      recruiter: { label: 'Recruiter', type: 'text', get: (x) => (x.recruiter && x.recruiter.label) || '—' },
      status: { label: 'Interview status', type: 'text', get: (x) => x.a.interviewStatus || '—' },
      result: { label: 'Result', type: 'text', get: (x) => x.a.interviewResult || '—' },
      mode: { label: 'Mode', type: 'text', get: (x) => x.a.interviewMode || '—' },
      interviewOn: { label: 'Interview date', type: 'date', get: (x) => C.istDay(x.a.interviewAt) },
      interviewMonth: { label: 'Interview month', type: 'month', get: (x) => month(C.istDay(x.a.interviewAt)) },
    },
    dateField: 'interviewOn',
    rows: (ctx) => ctx.apps.filter((x) => x.a.interviewAt),
  },
};
const OPS = {
  text: ['is', 'isnot', 'contains', 'in'],
  num: ['gte', 'lte', 'is'],
  date: ['gte', 'lte'],
  month: ['is', 'gte', 'lte'],
};
const RANGES = ['all', '7d', '30d', '90d', '180d', '365d', 'thisMonth', 'lastMonth', 'thisYear', 'custom'];
const CHARTS = ['bar', 'line', 'donut', 'table'];
const MAX_ROWS = 2000;
const MAX_GROUPS = 50;

// The whitelist as the screen needs it.
function schema() {
  return {
    entities: Object.entries(ENTITIES).map(([id, e]) => ({
      id, label: e.label, dateField: e.dateField,
      fields: Object.entries(e.fields).map(([k, f]) => ({ id: k, label: f.label, type: f.type, ops: OPS[f.type] })),
    })),
    ranges: RANGES, charts: CHARTS, measures: ['count', 'sum', 'avg'],
  };
}

const str = (v, n = 120) => String(v === null || v === undefined ? '' : v).slice(0, n);
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
// Anything not on the whitelist is dropped; returns { spec, dropped: [what was dropped] }.
function clean(raw) {
  const dropped = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  const entity = Object.prototype.hasOwnProperty.call(ENTITIES, r.entity) ? r.entity : 'applications';
  if (r.entity && r.entity !== entity) dropped.push(`entity ${str(r.entity, 30)}`);
  const E = ENTITIES[entity];
  const has = (k) => Object.prototype.hasOwnProperty.call(E.fields, k);
  const columns = (Array.isArray(r.columns) ? r.columns : []).map((c) => str(c, 40)).filter((c) => { if (has(c)) return true; dropped.push(`column ${c}`); return false; });
  const filters = (Array.isArray(r.filters) ? r.filters : []).slice(0, 12).map((f) => ({ field: str(f && f.field, 40), op: str(f && f.op, 10), value: f && f.value })).filter((f) => {
    if (!has(f.field) || !OPS[E.fields[f.field].type].includes(f.op)) { dropped.push(`filter ${f.field} ${f.op}`); return false; }
    const t = E.fields[f.field].type;
    if (f.op === 'in') f.value = (Array.isArray(f.value) ? f.value : String(f.value || '').split(',')).map((v) => str(v).trim()).filter(Boolean).slice(0, 30);
    else if (t === 'num') { f.value = Number(f.value); if (!Number.isFinite(f.value)) { dropped.push(`filter ${f.field}`); return false; } } else if (t === 'date') { if (!isDay(f.value)) { dropped.push(`filter ${f.field}`); return false; } } else f.value = str(f.value).trim();
    return true;
  });
  let range = RANGES.includes(r.range) ? r.range : 'all';
  const from = isDay(r.from) ? r.from : null; const to = isDay(r.to) ? r.to : null;
  if (range === 'custom' && !from && !to) range = 'all';
  const groupBy = r.groupBy && has(r.groupBy) && E.fields[r.groupBy].type !== 'num' ? r.groupBy : null;
  if (r.groupBy && !groupBy) dropped.push(`group by ${str(r.groupBy, 30)}`);
  let measure = { op: 'count', field: null };
  if (r.measure && ['sum', 'avg'].includes(r.measure.op) && has(r.measure.field) && E.fields[r.measure.field].type === 'num') measure = { op: r.measure.op, field: r.measure.field };
  const chart = CHARTS.includes(r.chart) ? r.chart : (groupBy ? (E.fields[groupBy].type === 'month' ? 'line' : 'bar') : 'table');
  const sort = ['value_desc', 'value_asc', 'label_asc', 'label_desc'].includes(r.sort) ? r.sort : (groupBy && E.fields[groupBy].type === 'month' ? 'label_asc' : 'value_desc');
  const limit = Math.max(1, Math.min(groupBy ? MAX_GROUPS : MAX_ROWS, Math.round(Number(r.limit) || (groupBy ? 20 : 500))));
  const title = str(r.title || '', 120).trim();
  return {
    spec: {
      entity, columns: columns.length ? columns : Object.keys(E.fields).slice(0, 6), filters, range, ...(range === 'custom' ? { from, to } : {}), groupBy, measure, chart, sort, limit, ...(title ? { title } : {}),
    },
    dropped,
  };
}

function rangeWindow(spec) {
  const t = C.today();
  const days = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[spec.range];
  if (days) return { from: C.addDays(t, -(days - 1)), to: t };
  if (spec.range === 'thisMonth') return { from: `${t.slice(0, 7)}-01`, to: t };
  if (spec.range === 'lastMonth') {
    const d = new Date(`${t.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
    const f = d.toISOString().slice(0, 10); const e = C.addDays(`${t.slice(0, 7)}-01`, -1);
    return { from: f, to: e };
  }
  if (spec.range === 'thisYear') return { from: `${t.slice(0, 4)}-01-01`, to: t };
  if (spec.range === 'custom') return { from: spec.from || '2015-01-01', to: spec.to || t };
  return null;
}
const matchOne = (v, f) => {
  const s = String(v === null || v === undefined ? '' : v);
  const w = f.value;
  switch (f.op) {
    case 'is': return typeof w === 'number' ? Number(v) === w : s.toLowerCase() === String(w).toLowerCase();
    case 'isnot': return s.toLowerCase() !== String(w).toLowerCase();
    case 'contains': return s.toLowerCase().includes(String(w).toLowerCase());
    case 'in': return w.some((x) => s.toLowerCase() === x.toLowerCase());
    case 'gte': return v !== null && v !== undefined && v !== '' && (typeof w === 'number' ? Number(v) >= w : s >= String(w));
    case 'lte': return v !== null && v !== undefined && v !== '' && (typeof w === 'number' ? Number(v) <= w : s <= String(w));
    default: return true;
  }
};

// Run a CLEAN spec over this login's scoped rows.
async function run(user, spec) {
  const E = ENTITIES[spec.entity];
  const ctx = await C.ctxFor(user, {});
  const prepared = E.prep ? E.prep(ctx) : {};
  let rows = E.rows(ctx);
  const needNames = Object.prototype.hasOwnProperty.call(E.fields, 'candidate') && (spec.columns.includes('candidate') || spec.groupBy === 'candidate' || spec.filters.some((f) => f.field === 'candidate'));
  const names = needNames ? await C.namesOf(rows.map((x) => x.a && x.a.candidateId)) : new Map();
  const val = (row, k) => E.fields[k].get(row, names, prepared);
  const win = rangeWindow(spec);
  if (win) rows = rows.filter((x) => { const d = val(x, E.dateField); return d && d >= win.from && d <= win.to; });
  spec.filters.forEach((f) => { rows = rows.filter((x) => matchOne(val(x, f.field), f)); });
  const columns = spec.columns.map((k) => ({ key: k, label: E.fields[k].label, type: E.fields[k].type }));
  const out = {
    entity: spec.entity, entityLabel: E.label, columns, total: rows.length, window: win, chart: spec.chart,
    title: spec.title || describe(spec),
  };
  if (spec.groupBy) {
    const g = new Map();
    rows.forEach((x) => {
      const k = val(x, spec.groupBy) || '—';
      const e = g.get(k) || { label: k, n: 0, sum: 0, vals: 0 };
      e.n += 1;
      if (spec.measure.field) { const v = Number(val(x, spec.measure.field)); if (Number.isFinite(v)) { e.sum += v; e.vals += 1; } }
      g.set(k, e);
    });
    let groups = [...g.values()].map((e) => ({
      key: e.label,
      label: E.fields[spec.groupBy].type === 'month' && e.label !== '—' ? C.monthLabel(e.label) : e.label,
      value: spec.measure.op === 'sum' ? Math.round(e.sum * 10) / 10 : spec.measure.op === 'avg' ? (e.vals ? Math.round((e.sum / e.vals) * 10) / 10 : 0) : e.n,
      count: e.n,
    }));
    const cmp = {
      value_desc: (a, b) => b.value - a.value, value_asc: (a, b) => a.value - b.value,
      label_asc: (a, b) => String(a.key).localeCompare(String(b.key)), label_desc: (a, b) => String(b.key).localeCompare(String(a.key)),
    }[spec.sort];
    groups.sort(cmp);
    out.groupCount = groups.length;
    groups = groups.slice(0, spec.limit);
    out.groupBy = { key: spec.groupBy, label: E.fields[spec.groupBy].label };
    out.measure = { ...spec.measure, label: spec.measure.op === 'count' ? 'Count' : `${spec.measure.op === 'sum' ? 'Total' : 'Average'} ${E.fields[spec.measure.field].label.toLowerCase()}` };
    out.groups = groups;
  }
  const lim = spec.groupBy ? MAX_ROWS : spec.limit;
  out.rows = rows.slice(0, lim).map((x) => columns.map((c) => {
    const v = val(x, c.key);
    return c.type === 'month' && v ? C.monthLabel(v) : (v === undefined ? null : v);
  }));
  out.cut = rows.length > out.rows.length;
  return out;
}

function describe(spec) {
  const E = ENTITIES[spec.entity];
  const what = spec.measure.op === 'count' ? E.label : `${spec.measure.op === 'sum' ? 'Total' : 'Average'} ${E.fields[spec.measure.field].label.toLowerCase()}`;
  const by = spec.groupBy ? ` by ${E.fields[spec.groupBy].label.toLowerCase()}` : '';
  const when = { all: '', '7d': ', last 7 days', '30d': ', last 30 days', '90d': ', last 90 days', '180d': ', last 6 months', '365d': ', last 12 months', thisMonth: ', this month', lastMonth: ', last month', thisYear: ', this year', custom: `, ${spec.from || '…'} to ${spec.to || 'today'}` }[spec.range];
  return `${what}${by}${when}`;
}

// --- "Ask for a chart" ------------------------------------------------------------------------------
// The keyword reader: always there, and the answer when no AI responds.
function parseQuestion(q) {
  const t = ` ${String(q || '').toLowerCase()} `;
  let entity = 'applications';
  if (/\bjoin(ed|ing|ings|ers)?\b|\bhires?\b|\bhired\b|placements?/.test(t)) entity = 'joinings';
  else if (/\binterviews?\b/.test(t)) entity = 'interviews';
  else if (/\b(requirements?|jobs?|openings?|vacanc(y|ies)|positions?)\b/.test(t)) entity = 'requirements';
  const E = ENTITIES[entity];
  const by = [
    [/\b(by|per|each|wise|every)\s+(month|monthly)|month[- ]?wise|month by month|trend|over time/, E.fields.joinedMonth ? 'joinedMonth' : E.fields.interviewMonth ? 'interviewMonth' : 'addedMonth'],
    [/\b(by|per|each)\s+client|client[- ]?wise/, 'client'],
    [/\b(by|per|each)\s+recruiter|recruiter[- ]?wise/, 'recruiter'],
    [/\b(by|per|each)\s+(team lead|tl)\b|tl[- ]?wise/, 'tl'],
    [/\b(by|per|each)\s+(bde|client manager)|bde[- ]?wise/, 'bde'],
    [/\b(by|per|each)\s+source|source[- ]?wise|where .* come from/, 'source'],
    [/\b(by|per|each)\s+department|department[- ]?wise|dept[- ]?wise/, 'department'],
    [/\b(by|per|each)\s+(stage|step)|stage[- ]?wise|(by|per) status|status[- ]?wise/, E.fields.stage ? 'stage' : 'status'],
    [/\b(by|per|each)\s+location|location[- ]?wise/, 'location'],
    [/\b(by|per|each)\s+(result|outcome)/, 'result'],
    [/\b(by|per|each)\s+(mode)/, 'mode'],
  ].find(([re, k]) => re.test(t) && E.fields[k]);
  const range = /last 7 days|this week|past week/.test(t) ? '7d' : /last 30 days|past month|last one month/.test(t) ? '30d' : /last 90 days|last 3 months|last quarter|past 3 months/.test(t) ? '90d'
    : /last 6 months|past 6 months/.test(t) ? '180d' : /last 12 months|last year|past year/.test(t) ? '365d' : /this month/.test(t) ? 'thisMonth' : /last month|previous month/.test(t) ? 'lastMonth' : /this year/.test(t) ? 'thisYear' : 'all';
  const filters = [];
  if (entity === 'requirements' && /\bopen\b/.test(t)) filters.push({ field: 'status', op: 'is', value: 'Open' });
  if (entity === 'requirements' && /\bclosed\b/.test(t)) filters.push({ field: 'status', op: 'is', value: 'Closed' });
  let measure = { op: 'count' };
  if (entity === 'joinings' && /(average|avg|usual|mean).*(days|time)|time to (fill|hire)/.test(t)) measure = { op: 'avg', field: /hire/.test(t) ? 'daysToHire' : 'daysToFill' };
  if (entity === 'requirements' && /openings/.test(t) && /(total|sum|how many)/.test(t)) measure = { op: 'sum', field: 'openings' };
  const chart = /\b(pie|donut|share)\b/.test(t) ? 'donut' : /\bline\b|trend/.test(t) ? 'line' : /\btable|list\b/.test(t) && !by ? 'table' : undefined;
  const top = /\btop\s+(\d{1,2})\b/.exec(t);
  return { entity, groupBy: by ? by[1] : null, range, filters, measure, chart, ...(top ? { limit: Number(top[1]) } : {}) };
}

const maskPii = (s) => String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\+?\d[\d\s-]{7,}\d/g, '[number]').slice(0, 400);
async function specFromQuestion(question) {
  const q = maskPii(question);
  const local = parseQuestion(q);
  let viaAi = false; let note = '';
  try {
    const fastAi = require('../fastAi'); // eslint-disable-line global-require
    const sc = schema();
    const system = [
      'You turn a recruitment manager\'s question into a JSON chart spec. Reply with JSON only, no words.',
      'Shape: {"entity": one of the entity ids, "groupBy": a field id or null, "range": one of the ranges, "filters": [{"field","op","value"}], "measure": {"op":"count"|"sum"|"avg","field": a num field or null}, "chart": "bar"|"line"|"donut"|"table", "limit": number, "title": short title}.',
      'Use ONLY these ids:', JSON.stringify(sc.entities.map((e) => ({ id: e.id, label: e.label, fields: e.fields.map((f) => `${f.id}:${f.type}`) }))),
      `Ranges: ${sc.ranges.join(', ')}. Text filters use op is|isnot|contains|in. A month field groups by month (use chart line for a trend).`,
    ].join('\n');
    const r = await fastAi.chat(system, [{ role: 'user', content: q }], { json: true, temperature: 0, maxTokens: 300, fallbackToApp: false, deadlineMs: 15000, timeoutMs: 12000 });
    const m = /\{[\s\S]*\}/.exec(String(r.text || ''));
    if (m) { const parsed = JSON.parse(m[0]); viaAi = true; note = `Built by ${r.provider}`; return { raw: parsed, viaAi, note }; }
  } catch (e) { note = 'Built from the words of the question (the AI did not answer)'; }
  return { raw: local, viaAi, note: note || 'Built from the words of the question' };
}

module.exports = { ENTITIES, schema, clean, run, describe, parseQuestion, specFromQuestion, maskPii, rangeWindow };
