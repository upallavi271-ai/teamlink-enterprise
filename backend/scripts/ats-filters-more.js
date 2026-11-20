/**
 * THE LISTS CONVERTED ON 2026-11-20 (founder: "every place, every list must have filters"): several values per filter (checkboxes),
 * a From / To day, a search, the export following the filters, and a TL / recruiter seeing only their own options.
 * Not a script of its own: scripts/ats-filters-test.js calls it on its private sandbox server, after its own checks.
 */
const sumOf = (list) => (list || []).reduce((s, o) => s + (Number(o.count) || 0), 0);
const optsOf = (facet) => ((facet && (facet.options || facet)) || []).filter((o) => Number(o.count) > 0);

module.exports = async function more(ctx) {
  const {
    check, call, qs, tA, tRA, tTL, RA, RB,
  } = ctx;

  // =====================================================================================================================
  // 1. THE ATS DASHBOARD DRILL LISTS (the rows behind a number) and THE JOBS BOARD
  // =====================================================================================================================
  const drillIds = (node, out = new Set()) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((x) => drillIds(x, out)); return out; }
    Object.entries(node).forEach(([k, v]) => {
      if (k === 'drill' && typeof v === 'string') out.add(v);
      else if (k === 'drills' && v && typeof v === 'object') Object.values(v).forEach((x) => { if (typeof x === 'string') out.add(x); });
      else drillIds(v, out);
    });
    return out;
  };
  const LIST = '/dashboard/ats/home/list';
  const drill = async (token, set, params = {}) => {
    const r = await call('GET', `${LIST}?${qs({ range: 'all', set, ...params })}`, null, token);
    return { status: r.status, b: r.body || {} };
  };
  const homeOf = async (token) => (await call('GET', `/dashboard/ats/home?${qs({ range: 'all' })}`, null, token)).body || {};
  // the first list of a kind whose facet `key` offers at least `n` values
  const pickSet = async (token, kind, key, n = 2) => {
    const ids = [...drillIds(await homeOf(token))].slice(0, 80);
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const d = await drill(token, id);
      if (d.status === 200 && d.b.kind === kind && optsOf((d.b.facets || {})[key]).length >= n) return { id, d };
    }
    return null;
  };
  const hit = await pickSet(tA, 'app', 'd_client', 3) || await pickSet(tA, 'app', 'd_client', 2);
  check('drill: a dashboard number with at least two clients behind it was found', !!hit, null);
  if (hit) {
    const cl = optsOf(hit.d.b.facets.d_client);
    const [a, b2, c] = cl;
    const one = await drill(tA, hit.id, { d_client: a.value });
    const two = await drill(tA, hit.id, { d_client: `${a.value},${b2.value}` });
    check('drill multi: one client lists that client\'s count', one.status === 200 && one.b.filtered === a.count, { want: a.count, got: one.b.filtered });
    check('drill multi: two clients list the sum of both (OR inside one filter)', two.b.filtered === a.count + b2.count, { want: a.count + b2.count, got: two.b.filtered });
    check('drill multi: the server says both ticked clients back', Array.isArray(two.b.picked.d_client) && two.b.picked.d_client.length === 2, two.b.picked);
    check('drill multi: the Client list keeps both ticked clients (own filter left out)', optsOf(two.b.facets.d_client).filter((o) => [a.value, b2.value].includes(o.value)).length === 2, null);
    if (c) {
      const three = await drill(tA, hit.id, { d_client: `${a.value},${b2.value},${c.value}` });
      check('drill multi: three clients list the sum of the three', three.b.filtered === a.count + b2.count + c.count, { want: a.count + b2.count + c.count, got: three.b.filtered });
    } else check('drill multi: three clients (only two in this list, skipped)', true);
    const rep = await drill(tA, hit.id, {}); // a repeated parameter works as well as a comma list
    const rr = await call('GET', `${LIST}?${qs({ range: 'all', set: hit.id })}&d_client=${encodeURIComponent(a.value)}&d_client=${encodeURIComponent(b2.value)}`, null, tA);
    check('drill multi: a repeated parameter (?d_client=a&d_client=b) is read like a comma list', rr.status === 200 && rr.body.filtered === two.b.filtered && rep.status === 200, { a: rr.body && rr.body.filtered, b: two.b.filtered });
    const steps = optsOf(two.b.facets.d_step);
    if (steps.length) {
      const both = await drill(tA, hit.id, { d_client: `${a.value},${b2.value}`, d_step: steps[0].value });
      check('drill multi: two clients AND one step (AND across filters) = the step\'s count under the two clients', both.b.filtered === steps[0].count, { want: steps[0].count, got: both.b.filtered });
    }
    const zero = await drill(tA, hit.id, { d_client: `${a.value},zzz-no-client` });
    check('drill multi: a ticked value with nothing behind it stays offered at 0', optsOf(zero.b.facets.d_client).some((o) => o.value === a.value) && ((zero.b.facets.d_client.options || []).find((o) => o.value === 'zzz-no-client') || {}).count === 0, (zero.b.facets.d_client.options || []).slice(-2));
    // the list's own date range (d_from / d_to over its "Last updated" day)
    check('drill dates: the list says which date its From / To is about', typeof hit.d.b.dateField === 'string' && hit.d.b.dateField.length > 0, hit.d.b.dateField);
    const future = await drill(tA, hit.id, { d_from: '2099-01-01' });
    check('drill dates: From in 2099 empties the list', future.status === 200 && future.b.filtered === 0, { n: future.b.filtered });
    const wide = await drill(tA, hit.id, { d_from: '2000-01-01', d_to: '2099-12-31' });
    check('drill dates: a wide range keeps every row', wide.b.filtered === hit.d.b.filtered, { a: wide.b.filtered, b: hit.d.b.filtered });
    const bad = await call('GET', `${LIST}?${qs({ range: 'all', set: hit.id, d_from: '2026-12-10', d_to: '2026-12-01' })}`, null, tA);
    check('drill dates: a reversed range is a plain 400', bad.status === 400, bad.status);
    // the export holds exactly the filtered rows
    const ex = await call('GET', `${LIST}?${qs({ range: 'all', set: hit.id, d_client: `${a.value},${b2.value}`, format: 'csv' })}`, null, tA);
    const lines = String(ex.text || '').trim().split(/\r?\n/).filter(Boolean);
    check('drill export: the CSV holds the two clients\' rows only (header + rows)', ex.status === 200 && lines.length - 1 === a.count + b2.count, { s: ex.status, lines: lines.length - 1, want: a.count + b2.count });
  }
  // the recruiter and the TL: options inside their own scope only
  const recHome = await homeOf(tRA);
  const recIds = [...drillIds(recHome)].slice(0, 40);
  let recLists = 0; let recLeak = 0; let recPeopleFacet = 0;
  for (const id of recIds) {
    // eslint-disable-next-line no-await-in-loop
    const d = await drill(tRA, id);
    if (d.status !== 200 || d.b.kind !== 'app') continue; // eslint-disable-line no-continue
    recLists += 1;
    if ((d.b.facets || {}).d_rec || (d.b.facets || {}).d_tl) recPeopleFacet += 1;
    // a recruiter asking for another recruiter's rows by the filter gets nothing extra
    // eslint-disable-next-line no-await-in-loop
    const x = await drill(tRA, id, { d_rec: `u:${RB.id},u:${RA.id}` });
    if (x.b.filtered !== d.b.filtered) recLeak += 1;
  }
  check('drill scope: recruiter A never gets a Recruiter or Team lead filter (on their own lists)', recLists > 0 && recPeopleFacet === 0, { recLists, recPeopleFacet });
  check('drill scope: recruiter A\'s ?d_rec=B,A is ignored (the list stays their own)', recLeak === 0, { recLists, recLeak });
  const tlHome = await homeOf(tTL);
  const tlIds = [...drillIds(tlHome)].slice(0, 40);
  let tlLists = 0; let tlTl = 0; let tlOutside = 0;
  for (const id of tlIds) {
    // eslint-disable-next-line no-await-in-loop
    const d = await drill(tTL, id);
    if (d.status !== 200 || d.b.kind !== 'app') continue; // eslint-disable-line no-continue
    tlLists += 1;
    if ((d.b.facets || {}).d_tl) tlTl += 1;
    // every option a TL is offered is a value of a row in their own list (counts add up to the rows)
    const rec = (d.b.facets || {}).d_rec;
    if (rec && sumOf(rec.options) !== d.b.filtered) tlOutside += 1;
  }
  check('drill scope: the TL gets no Team lead filter (it is them; on their own lists)', tlLists > 0 && tlTl === 0, { tlLists, tlTl });
  check('drill scope: the TL\'s Recruiter options count only the rows of their own list', tlOutside === 0, { tlLists, tlOutside });

  // the jobs board: department / client / team lead / recruiter take several values; Opened From / To
  const jobs = async (token, params = {}) => {
    const r = await call('GET', `${LIST}?${qs({ range: 'all', set: '__jobs', d_view: 'board', d_sort: 'attention', d_per: 6, ...params })}`, null, token);
    return { status: r.status, b: r.body || {} };
  };
  const jb = await jobs(tA);
  check('jobs board: answers with its filters', jb.status === 200 && !!jb.b.facets, { s: jb.status });
  const jd = optsOf((jb.b.facets || {}).department);
  if (jd.length >= 2) {
    const two = await jobs(tA, { d_dept: `${jd[0].value},${jd[1].value}` });
    check('jobs board multi: two departments hold the open jobs of both', two.b.summary.open === jd[0].count + jd[1].count, { want: jd[0].count + jd[1].count, got: two.b.summary.open });
    if (jd.length >= 3) {
      const three = await jobs(tA, { d_dept: `${jd[0].value},${jd[1].value},${jd[2].value}` });
      check('jobs board multi: three departments', three.b.summary.open === jd[0].count + jd[1].count + jd[2].count, { got: three.b.summary.open });
    }
    check('jobs board multi: both ticked departments stay in the list', optsOf(two.b.facets.department).filter((o) => [jd[0].value, jd[1].value].includes(o.value)).length === 2, null);
  } else check('jobs board multi: two departments (one department here, skipped)', true);
  const jc = optsOf((jb.b.facets || {}).client);
  if (jc.length >= 2) {
    const two = await jobs(tA, { d_client: `${jc[0].value},${jc[1].value}` });
    check('jobs board multi: two clients hold the open jobs of both', two.b.summary.open === jc[0].count + jc[1].count, { want: jc[0].count + jc[1].count, got: two.b.summary.open });
    const ex = await call('GET', `${LIST}?${qs({ range: 'all', set: '__jobs', d_client: `${jc[0].value},${jc[1].value}`, d_size: 100 })}`, null, tA);
    check('jobs board export source: the flat list with two clients holds only those clients', ex.status === 200 && (ex.body.rows || []).every((r) => [jc[0].label, jc[1].label].includes(r.client || 'No client')), (ex.body.rows || []).map((r) => r.client).slice(0, 5));
  }
  const jf = await jobs(tA, { d_from: '2099-01-01' });
  check('jobs board dates: opened from 2099 holds nothing', jf.status === 200 && jf.b.summary.open === 0, jf.b.summary && jf.b.summary.open);
  const jw = await jobs(tA, { d_from: '2000-01-01', d_to: '2099-12-31' });
  check('jobs board dates: a wide range keeps every open job', jw.b.summary.open === jb.b.summary.open, { a: jw.b.summary.open, b: jb.b.summary.open });
  const jr = await jobs(tRA);
  check('jobs board scope: recruiter A\'s department options count only their own jobs', jr.status !== 200 || sumOf((jr.b.facets || {}).department) === jr.b.summary.open, jr.b.summary && { open: jr.b.summary.open, sum: sumOf((jr.b.facets || {}).department) });
  const jt = await jobs(tTL);
  const jtFlat = await call('GET', `${LIST}?${qs({ range: 'all', set: '__jobs', d_size: 100 })}`, null, tTL);
  const tlRecs = new Set(((jtFlat.body && jtFlat.body.rows) || []).flatMap((r) => r.recruiterIds || []));
  const tlRecOpts = optsOf((jt.b.facets || {}).rec).filter((o) => o.value !== '__none__');
  check('jobs board scope: every recruiter the TL is offered works on a job the TL sees', jt.status === 200 && tlRecOpts.every((o) => tlRecs.has(o.value)), { opts: tlRecOpts.map((o) => o.value).slice(0, 5), seen: tlRecs.size });

  return ctx;
};
