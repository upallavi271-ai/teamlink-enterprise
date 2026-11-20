/**
 * THE LISTS CONVERTED ON 2026-11-20 (founder: "every place, every list must have filters"): several values per filter (checkboxes),
 * a From / To day, a search, the export following the filters, and a TL / recruiter seeing only their own options.
 * Not a script of its own: scripts/ats-filters-test.js calls it on its private sandbox server, after its own checks.
 */
const sumOf = (list) => (list || []).reduce((s, o) => s + (Number(o.count) || 0), 0);
const optsOf = (facet) => ((facet && (facet.options || facet)) || []).filter((o) => Number(o.count) > 0);

module.exports = async function more(ctx) {
  const {
    check, call, qs, tA, tRA, tTL, RA, RB, TLU, adminRow,
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

  // =====================================================================================================================
  // 2. THE CONTROL TOWER DRAWER (Super Admin / Admin): checkbox filters f_<key>, From / To dFrom / dTo, the file follows
  // =====================================================================================================================
  const CT = '/dashboard/control-tower/list';
  const ct = async (set, params = {}, token = tA) => { const r = await call('GET', `${CT}?${qs({ set, pageSize: 100, ...params })}`, null, token); return { status: r.status, b: r.body || {} }; };
  const fac = (b, key) => ((b.facets || []).find((f) => f.key === key) || {}).options || [];
  // two- and three-value checks over one facet of one set: the totals add up (single-valued column, OR inside one filter)
  const sumCheck = async (set, key, params = {}) => {
    const all = await ct(set, params);
    const o = fac(all.b, key).filter((x) => x.count > 0);
    if (all.status !== 200) { check(`control tower ${set}: answers`, false, { s: all.status, e: all.b.error }); return null; }
    if (o.length < 2) { check(`control tower ${set} multi ${key}: fewer than two values here, skipped`, true); return all; }
    const two = await ct(set, { ...params, [`f_${key}`]: `${o[0].value},${o[1].value}` });
    check(`control tower ${set} multi: two ${key} values list the sum of both`, two.b.total === o[0].count + o[1].count, { want: o[0].count + o[1].count, got: two.b.total });
    check(`control tower ${set} multi: both ticked ${key} values stay offered`, fac(two.b, key).filter((x) => [o[0].value, o[1].value].includes(x.value)).length === 2, null);
    if (o.length >= 3) {
      const three = await ct(set, { ...params, [`f_${key}`]: `${o[0].value},${o[1].value},${o[2].value}` });
      check(`control tower ${set} multi: three ${key} values`, three.b.total === o[0].count + o[1].count + o[2].count, { got: three.b.total });
    }
    return all;
  };
  const ctEmp = await sumCheck('employees', 'dept', { filter: 'all' });
  if (ctEmp) {
    check('control tower employees: no salary, location, gender or birthday filter is offered', !(ctEmp.b.facets || []).some((f) => /salary|ctc|location|city|gender|age|birth|religion|caste|marital/i.test(`${f.key} ${f.label}`)), (ctEmp.b.facets || []).map((f) => f.key));
    check('control tower employees: the list names its date (Joined on)', ctEmp.b.dateField === 'Joined on', ctEmp.b.dateField);
  }
  await sumCheck('requirements', 'dept', { filter: 'all' });
  const ctReq = await sumCheck('requirements', 'client', { filter: 'all' });
  if (ctReq) {
    const st = fac(ctReq.b, 'status').filter((x) => x.count > 0);
    const de = fac(ctReq.b, 'dept').filter((x) => x.count > 0);
    if (st.length && de.length) {
      const both = await ct('requirements', { filter: 'all', f_dept: de[0].value, f_status: st.map((x) => x.value).join(',') });
      check('control tower requirements: one department AND every status = that department', both.b.total === de[0].count, { want: de[0].count, got: both.b.total });
    }
    const fut = await ct('requirements', { filter: 'all', dFrom: '2099-01-01' });
    check('control tower requirements: posted from 2099 holds nothing', fut.status === 200 && fut.b.total === 0, fut.b.total);
    const wide = await ct('requirements', { filter: 'all', dFrom: '2000-01-01', dTo: '2099-12-31' });
    check('control tower requirements: a wide range keeps them all', wide.b.total === ctReq.b.total, { a: wide.b.total, b: ctReq.b.total });
    const today = ctx.dayOf(new Date());
    const td = await ct('requirements', { filter: 'all', dFrom: today, dTo: today });
    const tdRows = (td.b.rows || []).every((r) => ctx.dayOf(new Date(r.c.created)) === today);
    check('control tower requirements: a one-day range holds only that IST day', td.status === 200 && tdRows, { n: td.b.total });
    const bad = await call('GET', `${CT}?${qs({ set: 'requirements', dFrom: '2026-12-10', dTo: '2026-12-01' })}`, null, tA);
    check('control tower: a reversed range is a plain 400', bad.status === 400, bad.status);
  }
  await sumCheck('candidates', 'client');
  await sumCheck('candidates', 'stage');
  const ctc = await ct('candidates', { q: ctx.TAG });
  check('control tower candidates: the search finds the seeded people', ctc.status === 200 && ctc.b.total >= 5, { n: ctc.b.total });
  await sumCheck('audit', 'entity', { dFrom: ctx.dayOf(new Date(Date.now() - 7 * 86400e3)) });
  for (const [who, tok] of [['recruiter', tRA], ['team lead', tTL]]) {
    // eslint-disable-next-line no-await-in-loop
    const x = await ct('employees', { f_dept: 'Sales' }, tok);
    check(`control tower: a ${who} is refused the company-wide lists (filters or not)`, x.status === 403, x.status);
  }

  // =====================================================================================================================
  // 3. THE REPORT PAGES: daily report, team & person report pack, joining & drop, partners, follow-up report
  // =====================================================================================================================
  const get = async (url, params, token = tA) => { const r = await call('GET', `${url}?${qs(params)}`, null, token); return { status: r.status, b: r.body || {}, text: r.text }; };
  const pos = (list) => (list || []).filter((o) => Number(o.count) > 0);
  // "OR inside one filter": the result with two (three) values equals the results of each added up
  const additive = async (name, url, base, key, opts, total) => {
    const o = pos(opts);
    if (o.length < 2) { check(`${name} multi ${key}: fewer than two values here, skipped`, true); return; }
    const one = await Promise.all(o.slice(0, 3).map((x) => get(url, { ...base, [key]: x.value })));
    const two = await get(url, { ...base, [key]: `${o[0].value},${o[1].value}` });
    check(`${name} multi: two ${key} values = the two added up`, two.status === 200 && total(two.b) === total(one[0].b) + total(one[1].b), { s: two.status, a: total(one[0].b), b: total(one[1].b), ab: total(two.b) });
    if (o.length >= 3) {
      const three = await get(url, { ...base, [key]: `${o[0].value},${o[1].value},${o[2].value}` });
      check(`${name} multi: three ${key} values = the three added up`, total(three.b) === total(one[0].b) + total(one[1].b) + total(one[2].b), { abc: total(three.b) });
    }
  };
  const month = ctx.dayOf(new Date()).slice(0, 7);
  // the daily report (month view): work items per department / person
  const dTot = (b) => Object.values(b.totals || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  const dm = await get('/ats-daily/month', { month });
  check('daily report: the month answers with its options', dm.status === 200 && !!dm.b.options, { s: dm.status, e: dm.b.error });
  if (dm.status === 200) {
    await additive('daily report', '/ats-daily/month', { month }, 'department', dm.b.options.departments, dTot);
    await additive('daily report', '/ats-daily/month', { month }, 'person', dm.b.options.people, dTot);
    const dp = pos(dm.b.options.people);
    if (dp.length >= 2) {
      const two = await get('/ats-daily/month', { month, person: `${dp[0].value},${dp[1].value}` });
      check('daily report multi: both ticked people stay in the Recruiter list', pos(two.b.options.people).filter((x) => [dp[0].value, dp[1].value].includes(x.value)).length === 2, null);
      const zero = await get('/ats-daily/month', { month, person: `${dp[0].value},u:no-such-person` });
      check('daily report multi: a ticked person with no work stays offered at 0', (zero.b.options.people || []).some((x) => x.value === 'u:no-such-person' && x.count === 0), null);
    }
  }
  const dr = await get('/ats-daily/month', { month, department: 'Zzz,Yyy' }, tRA);
  check('daily report scope: a recruiter is held to their own work whatever the filter says', dr.status !== 200 || dr.b.selfOnly === true, { s: dr.status, self: dr.b.selfOnly });
  // the team & person report pack
  const rpBase = { report: 'summary', view: 'individual', range: 'this_year' };
  const rpRows = (b) => (b.rows || []).filter((r) => r.key && !String(r.key).startsWith('team:')).length;
  const rp0 = await get('/ats-report-pack/report', rpBase);
  check('report pack: the summary answers with its filters', rp0.status === 200 && !!rp0.b.options, { s: rp0.status, e: rp0.b.error });
  if (rp0.status === 200) {
    await additive('report pack', '/ats-report-pack/report', rpBase, 'department', rp0.b.options.departments, rpRows);
    await additive('report pack', '/ats-report-pack/report', rpBase, 'person', rp0.b.options.people, rpRows);
    const pp = pos(rp0.b.options.people);
    if (pp.length >= 2) {
      const ex = await get('/ats-report-pack/export', { ...rpBase, person: `${pp[0].value},${pp[1].value}`, format: 'csv' });
      check('report pack export: the file with two people answers and names both', ex.status === 200 && [pp[0], pp[1]].every((p) => String(ex.text).includes(String(p.label).replace(/ - Former$/, ''))), { s: ex.status, head: String(ex.text).slice(0, 160) });
    }
  }
  // joining & drop
  const jd0 = await get('/join-drop/list', { pageSize: 5 });
  check('joining & drop: the list answers with its filters', jd0.status === 200 && !!jd0.b.facets, { s: jd0.status, e: jd0.b.error });
  if (jd0.status === 200) {
    await additive('joining & drop', '/join-drop/list', { pageSize: 5 }, 'department', jd0.b.facets.departments, (b) => b.total);
    await additive('joining & drop', '/join-drop/list', { pageSize: 5 }, 'clientId', jd0.b.facets.clients, (b) => b.total);
    await additive('joining & drop', '/join-drop/list', { pageSize: 5 }, 'recruiter', jd0.b.facets.recruiters, (b) => b.total);
    const st = await get('/join-drop/list', { pageSize: 5, status: 'Joined,Dropped' });
    check('joining & drop multi: Joined and Dropped together = everything', st.b.total === jd0.b.total, { a: st.b.total, all: jd0.b.total });
    const jc = pos(jd0.b.facets.clients);
    if (jc.length >= 2) {
      const two = await get('/join-drop/list', { pageSize: 5, clientId: `${jc[0].value},${jc[1].value}` });
      const ex = await call('GET', `/join-drop/export?${qs({ clientId: `${jc[0].value},${jc[1].value}` })}`, null, tA);
      const lines = String(ex.text || '').replace(/^﻿/, '').trim().split(/\r?\n/).filter((l) => l.trim());
      check('joining & drop export: the file holds the two clients\' rows (header + rows)', ex.status === 200 && lines.length - 1 === two.b.total, { s: ex.status, lines: lines.length - 1, want: two.b.total });
    }
  }
  const jdr = await get('/join-drop/list', { pageSize: 50, recruiter: `${RB.id},${RA.id}` }, tRA);
  check('joining & drop scope: recruiter A asking for B and A sees no row of B', jdr.status !== 200 || (jdr.b.rows || []).every((r) => !r.recruiterUserId || r.recruiterUserId !== RB.id), { s: jdr.status });
  // partners
  const pr0 = await get('/partners/report', {});
  if (pr0.status === 200) {
    await additive('partners', '/partners/report', {}, 'department', pr0.b.facets.department, (b) => (b.totals || {}).submitted || 0);
    await additive('partners', '/partners/report', {}, 'partnerId', pr0.b.facets.partnerId, (b) => (b.totals || {}).submitted || 0);
  } else check('partners report: answers for the Super Admin', false, { s: pr0.status, e: pr0.b.error });
  // the follow-up report
  const today = ctx.dayOf(new Date());
  const fuBase = { from: `${today.slice(0, 8)}01`, to: today, period: 'day', imported: 'include' };
  const fr0 = await get('/followup-report/summary', fuBase);
  check('follow-up report: the summary answers for the Super Admin', fr0.status === 200, { s: fr0.status, e: fr0.b.error });
  if (fr0.status === 200) {
    const ids = (b) => new Set((b.rows || []).map((r) => r.id));
    const deps = fr0.b.departments || [];
    if (deps.length >= 2) {
      const a = await get('/followup-report/summary', { ...fuBase, department: deps[0] });
      const b2 = await get('/followup-report/summary', { ...fuBase, department: deps[1] });
      const ab = await get('/followup-report/summary', { ...fuBase, department: `${deps[0]},${deps[1]}` });
      check('follow-up report multi: two departments list the people of both', ab.status === 200 && ids(ab.b).size === new Set([...ids(a.b), ...ids(b2.b)]).size, { a: ids(a.b).size, b: ids(b2.b).size, ab: ids(ab.b).size });
      if (deps.length >= 3) {
        const c = await get('/followup-report/summary', { ...fuBase, department: deps[2] });
        const abc = await get('/followup-report/summary', { ...fuBase, department: deps.slice(0, 3).join(',') });
        check('follow-up report multi: three departments', ids(abc.b).size === new Set([...ids(a.b), ...ids(b2.b), ...ids(c.b)]).size, { abc: ids(abc.b).size });
      }
    } else check('follow-up report multi: two departments (one here, skipped)', true);
    const leads = (fr0.b.leads || []).filter((l) => l.count > 0);
    if (leads.length >= 2) {
      const a = await get('/followup-report/summary', { ...fuBase, leadId: leads[0].id });
      const b2 = await get('/followup-report/summary', { ...fuBase, leadId: leads[1].id });
      const ab = await get('/followup-report/summary', { ...fuBase, leadId: `${leads[0].id},${leads[1].id}` });
      const want = new Set([...ids(a.b), ...ids(b2.b)]);
      check('follow-up report multi: two team leads list both teams', ab.status === 200 && [...want].every((id) => ids(ab.b).has(id)), { a: ids(a.b).size, b: ids(b2.b).size, ab: ids(ab.b).size, s: ab.status });
      const ex = await call('GET', `/followup-report/export?${qs({ ...fuBase, leadId: `${leads[0].id},${leads[1].id}`, format: 'csv' })}`, null, tA);
      check('follow-up report export: the file with two team leads answers', [200, 404].includes(ex.status), ex.status);
    } else check('follow-up report multi: two team leads (fewer here, skipped)', true);
    const bad = await get('/followup-report/summary', { ...fuBase, leadId: `${TLU.id},zz-not-a-lead` });
    check('follow-up report: an unknown team lead among the ticked ones is refused, not ignored', bad.status === 404, bad.status);
  }
  const ftl = await get('/followup-report/summary', { ...fuBase, leadId: `${TLU.id},${adminRow.id}` }, tTL);
  check('follow-up report scope: a TL ticking another lead\'s team is refused', ftl.status === 403, ftl.status);
  const ftl2 = await get('/followup-report/summary', { ...fuBase, leadId: TLU.id }, tTL);
  check('follow-up report scope: a TL may pick their own team', ftl2.status === 200, { s: ftl2.status, e: ftl2.b.error });
  const frec = await get('/followup-report/summary', { ...fuBase, leadId: `${RA.id},${RB.id}` }, tRA);
  check('follow-up report scope: a recruiter ticking another person is refused', frec.status === 403, frec.status);

  return ctx;
};
