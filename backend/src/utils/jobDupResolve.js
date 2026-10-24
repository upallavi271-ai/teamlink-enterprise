// ---------------------------------------------------------------------------
// DUPLICATE JOBS — the worklist, the compare card and every resolution (Clients & Requirements > Jobs > Duplicate jobs).
// Routes: routes/jobDuplicates.js (mounted at /api/job-duplicates).
//
// WHO (server enforced; the screen only hides what the server would refuse):
//   Super Admin · Admin · BDE TL · BDE   resolve (merge · not a duplicate · close the extra). A BDE only inside their own
//                                        clients' jobs (utils/scope.js requirementWhere); the BDE TL and the admins see all.
//   Manager · Asst Manager               see the list (view only: they approve, they do not edit) and press "Ask the client manager to merge"
//   TL · STL · Recruiter                 no list. On a job that has a twin they see a small note and the "Ask the client manager to merge" button
//   HR · Accountant · Employee · client  nothing
// Nothing is hard-deleted by anybody here: the extra job is merged into the kept one and CLOSED (utils/jobMerge.js).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const D = require('./jobDupes');
const M = require('./jobMerge');
const JC = require('./jobCreateRule');
const SC = require('./scope');
const { stageLabel, requirementStatusLabel, requirementStatusUser } = require('./atsVocab');
const { appRank } = require('./candidateDedupe');

const out = (status, body) => ({ status, body });
const err = (status, error, extra = {}) => out(status, { error, ...extra });
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const clusterIdOf = (ids) => crypto.createHash('sha1').update([...ids].sort().join('|')).digest('hex').slice(0, 16);

// -> { kind, resolve, view, ask, global }
function actorKind(user) {
  const kind = JC.kindOf(user);
  const resolve = ['admin', 'bde', 'bdeTl'].includes(kind);
  return {
    kind, resolve, global: kind === 'admin' || kind === 'bdeTl',
    view: resolve || ['manager', 'am'].includes(kind),
    ask: ['manager', 'am', 'TL', 'STL', 'RECRUITER'].includes(kind),
  };
}
const isSuper = (user) => { try { return require('./clientLifecycle').isSuperAdmin(user); } catch { return false; } }; // eslint-disable-line global-require

// the ids of the jobs this login may touch (null = all)
async function scopeIds(user, kind, ids) {
  if (kind.global && kind.kind === 'admin') return null;
  const where = SC.requirementWhere(user);
  const rows = await prisma.requirement.findMany({ where: { AND: [{ id: { in: ids } }, where] }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

// --- the people / client names ---------------------------------------------------------------------
async function namesFor(clusters) {
  const clientIds = new Set(); const userIds = new Set();
  clusters.forEach((c) => c.jobs.forEach((j) => { clientIds.add(j.clientId); [j.bdeId, j.tlId, j.recruiterId].filter(Boolean).forEach((u) => userIds.add(u)); }));
  const [cl, us] = await Promise.all([
    clientIds.size ? prisma.client.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true, ownerDepartment: true } }) : [],
    userIds.size ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
  ]);
  return { client: new Map(cl.map((c) => [c.id, c])), user: new Map(us.map((u) => [u.id, u.name])) };
}

// the kept job we suggest: the one with the invoices / joined people, then the most candidates, the furthest step, the oldest
function suggestKept(jobs, st) {
  const score = (j) => {
    const s = st[j.id] || { apps: 0, steps: {}, joined: 0, invoices: 0 };
    const far = Math.max(0, ...Object.keys(s.steps).map((k) => appRank({ stage: k })));
    const open = j.status === 'CLOSED' ? 0 : 1;
    return s.invoices * 100000 + s.joined * 10000 + s.apps * 100 + far * 5 + open * 3;
  };
  return [...jobs].sort((a, b) => score(b) - score(a) || D.ts(a.createdAt) - D.ts(b.createdAt))[0];
}

// one cluster as the screen draws it
function shape(c, byId, st, names, kind) {
  const jobs = c.jobIds.map((id) => byId.get(id)).filter(Boolean).map((p) => p.j).sort((a, b) => D.ts(a.createdAt) - D.ts(b.createdAt));
  const kept = suggestKept(jobs, st);
  const extras = jobs.filter((j) => j.id !== kept.id);
  const blocked = [];
  extras.forEach((j) => {
    if ((st[j.id] || {}).invoices) blocked.push(`${j.reqCode || 'A requirement'} has an invoice, so it cannot be merged away. Keep it, or ask Accounts.`);
  });
  const cl = names.client.get(c.clientId);
  return {
    id: clusterIdOf(c.jobIds), level: c.level, clientId: c.clientId, client: cl ? cl.name : '', department: (jobs[0] && jobs[0].department) || (cl && cl.ownerDepartment) || null,
    reasons: c.reasons, keptId: kept.id, blocked, canMerge: kind.resolve && !blocked.length,
    jobs: jobs.map((j) => {
      const s = st[j.id] || { apps: 0, steps: {}, joined: 0, invoices: 0, postings: [], interviews: 0, offers: 0 };
      return {
        id: j.id, reqCode: j.reqCode, title: j.title, status: j.status, statusLabel: requirementStatusUser(j.status), openings: j.openings, location: j.location || null,
        specialisation: j.specialisation || null, salary: j.salary || null, experience: j.experience || null, createdAt: j.createdAt, department: j.department || null,
        bde: j.bdeId ? names.user.get(j.bdeId) || null : null, tl: j.tlId ? names.user.get(j.tlId) || j.tl || null : (j.tl || null), recruiter: j.recruiterId ? names.user.get(j.recruiterId) || null : null,
        candidates: s.apps, steps: Object.entries(s.steps).map(([k, n]) => ({ step: k, label: stageLabel(k), count: n })).sort((a, b) => appRank({ stage: b.step }) - appRank({ stage: a.step })),
        joined: s.joined, invoices: s.invoices, postings: s.postings, interviews: s.interviews, offers: s.offers, suggestedKeep: j.id === kept.id,
      };
    }),
  };
}

// --- who sees which clusters --------------------------------------------------------------------------
async function visibleClusters(user, data) {
  const kind = actorKind(user);
  if (!kind.view) return { kind, clusters: [] };
  const ids = [...new Set(data.clusters.flatMap((c) => c.jobIds))];
  const allowed = await scopeIds(user, kind, ids);
  if (allowed === null) return { kind, clusters: data.clusters };
  const clusters = data.clusters.map((c) => {
    const vis = c.jobIds.filter((i) => allowed.has(i));
    return vis.length >= 2 ? { ...c, jobIds: vis } : null;
  }).filter(Boolean);
  return { kind, clusters };
}

// The header badge: how many need a look.
async function status(user) {
  const kind = actorKind(user);
  if (!kind.view) return out(200, { visible: false, canResolve: false, must: 0, likely: 0, maybe: 0, badge: 0 });
  const data = D.isHard() ? await D.everything() : D.peek(); // right after a merge the count is rebuilt; a cold start never makes the tab wait
  if (!data) return out(200, { visible: true, canResolve: kind.resolve, canAsk: kind.ask && !kind.resolve, building: true, must: 0, likely: 0, maybe: 0, badge: 0, supported: await D.supported() });
  const { clusters } = await visibleClusters(user, data);
  const n = (lv) => clusters.filter((c) => c.level === lv).length;
  return out(200, { visible: true, canResolve: kind.resolve, canAsk: kind.ask && !kind.resolve, must: n('CERTAIN'), likely: n('LIKELY'), maybe: n('POSSIBLE'), badge: n('CERTAIN') + n('LIKELY'), supported: await D.supported(), builtAt: new Date(data.at).toISOString() });
}

// --- cascading filters -----------------------------------------------------------------------------------
const FILTERS = ['department', 'client', 'bde', 'tl'];
function facetsOf(rows, q) {
  const get = {
    department: (c) => [c.department || '(none)'],
    client: (c) => [c.clientId],
    bde: (c) => [...new Set(c.jobs.map((j) => j.bdeId || '(none)'))],
    tl: (c) => [...new Set(c.jobs.map((j) => j.tlId || '(none)'))],
  };
  const out2 = {};
  FILTERS.forEach((f) => {
    const others = rows.filter((c) => FILTERS.every((g) => g === f || !q[g] || get[g](c).includes(q[g])));
    const m = new Map();
    others.forEach((c) => get[f](c).forEach((v) => m.set(v, (m.get(v) || 0) + 1)));
    out2[f] = m;
  });
  return { get, byFilter: out2 };
}

// GET /worklist?tab=must|likely|maybe|done&department=&client=&bde=&tl=&search=&page=&pageSize=
async function worklist(user, query = {}) {
  const kind = actorKind(user);
  if (!kind.view) return err(403, 'Not available to this login.');
  const tab = ['must', 'likely', 'maybe', 'done'].includes(query.tab) ? query.tab : 'must';
  const data = await D.everything();
  const { clusters } = await visibleClusters(user, data);
  // rows carry what the filters need
  const rows = clusters.map((c) => {
    const jobs = c.jobIds.map((id) => (data.byId.get(id) || {}).j).filter(Boolean);
    return { c, jobs: jobs.map((j) => ({ id: j.id, bdeId: j.bdeId, tlId: j.tlId })), clientId: c.clientId, department: (jobs[0] && jobs[0].department) || null, level: c.level };
  });
  const q = { department: clean(query.department, 80), client: clean(query.client, 60), bde: clean(query.bde, 60), tl: clean(query.tl, 60) };
  const search = clean(query.search, 80).toLowerCase();
  const levelOf = { must: 'CERTAIN', likely: 'LIKELY', maybe: 'POSSIBLE' }[tab];
  const inTab = rows.filter((r) => r.level === levelOf);
  const { get, byFilter } = facetsOf(inTab, q);
  const matching = inTab.filter((r) => FILTERS.every((f) => !q[f] || get[f](r).includes(q[f])));

  // names for the filter options and the cards
  const names = await namesFor(rows.map((r) => ({ jobs: r.jobs.map((j) => ({ ...j, clientId: r.clientId })) })));
  const label = {
    department: (v) => v,
    client: (v) => (names.client.get(v) || {}).name || v,
    bde: (v) => (v === '(none)' ? 'No BDE named' : names.user.get(v) || v),
    tl: (v) => (v === '(none)' ? 'No TL named' : names.user.get(v) || v),
  };
  const facets = {};
  FILTERS.forEach((f) => {
    const opts = [...byFilter[f].entries()].map(([value, count]) => ({ value, label: label[f](value), count })).filter((o) => o.count > 0).sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
    if (q[f] && !opts.find((o) => o.value === q[f])) opts.unshift({ value: q[f], label: label[f](q[f]), count: 0 });
    facets[f] = opts;
  });
  const tabCounts = { must: rows.filter((r) => r.level === 'CERTAIN').length, likely: rows.filter((r) => r.level === 'LIKELY').length, maybe: rows.filter((r) => r.level === 'POSSIBLE').length };

  if (tab === 'done') {
    const merges = await recentMerges(user, kind);
    return out(200, { tab, kind: kind.kind, canResolve: kind.resolve, canAsk: kind.ask && !kind.resolve, counts: tabCounts, facets, merges: merges.body.merges, decisions: (await decisionList(user, kind)), total: merges.body.merges.length, groups: [], page: 1, pages: 1 });
  }

  // search + page (grouped by client). The people / steps numbers are read for ONE page only (cold load stays fast).
  const pageSize = Math.min(50, Math.max(5, Number(query.pageSize) || 20));
  const nameOf = (c) => ((names.client.get(c.clientId) || {}).name || '');
  let need = matching.map((r) => r.c);
  if (search) {
    need = need.filter((c) => `${nameOf(c)} ${c.jobIds.map((id) => { const j = (data.byId.get(id) || {}).j || {}; return `${j.reqCode} ${j.title} ${j.location || ''}`; }).join(' ')}`.toLowerCase().includes(search));
  }
  need.sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || b.score - a.score);
  const pages = Math.max(1, Math.ceil(need.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));
  const pageClusters = need.slice((page - 1) * pageSize, page * pageSize);
  const stPage = await M.statsFor([...new Set(pageClusters.flatMap((c) => c.jobIds))]);
  const pageNames = await namesFor(pageClusters.map((c) => ({ jobs: c.jobIds.map((id) => ({ ...((data.byId.get(id) || {}).j || {}), clientId: c.clientId })) })));
  const slice = pageClusters.map((c) => shape(c, data.byId, stPage, pageNames, kind));
  const full = need;
  const groups = [];
  slice.forEach((s) => { let g = groups[groups.length - 1]; if (!g || g.clientId !== s.clientId) { g = { clientId: s.clientId, client: s.client, clusters: [] }; groups.push(g); } g.clusters.push(s); });
  return out(200, { tab, kind: kind.kind, canResolve: kind.resolve, canAsk: kind.ask && !kind.resolve, counts: tabCounts, facets, total: full.length, page, pages, groups, builtAt: new Date(data.at).toISOString(), supported: await D.supported() });
}

// --- the "Done" tab ------------------------------------------------------------------------------------------
async function recentMerges(user, kind) {
  if (!(await D.supported())) return out(200, { merges: [] });
  const since = Date.now() - 60 * D.DAY;
  const rows = await D.q('SELECT * FROM JobMergeLog WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT 100', since);
  let allowed = null;
  if (!kind.global) allowed = await scopeIds(user, kind, [...new Set(rows.flatMap((r) => [r.keptId, r.extraId]))]);
  const merges = rows.filter((r) => allowed === null || allowed.has(r.keptId) || allowed.has(r.extraId)).map((r) => ({ ...M.undoState(r), canUndoNow: kind.resolve && M.undoState(r).canUndo }));
  return out(200, { merges });
}
async function decisionList(user, kind) {
  if (!(await D.supported())) return [];
  const rows = await D.q('SELECT * FROM JobDupDecision ORDER BY createdAt DESC LIMIT 60');
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.jobAId, r.jobBId]))];
  const jobs = await prisma.requirement.findMany({ where: { id: { in: ids } }, select: { id: true, reqCode: true, title: true, clientId: true } });
  const by = new Map(jobs.map((j) => [j.id, j]));
  const allowed = kind.global ? null : await scopeIds(user, kind, ids);
  return rows.filter((r) => allowed === null || allowed.has(r.jobAId) || allowed.has(r.jobBId)).map((r) => ({
    id: r.id, a: by.get(r.jobAId) || { id: r.jobAId }, b: by.get(r.jobBId) || { id: r.jobBId }, reason: r.reason, by: r.decidedByName, at: new Date(Number(r.createdAt)).toISOString(),
  }));
}
const mergesList = async (user) => recentMerges(user, actorKind(user));

// --- resolutions -----------------------------------------------------------------------------------------------
async function requireResolver(user, ids) {
  const kind = actorKind(user);
  if (!kind.resolve) return { error: err(403, 'Merging requirements is for the client manager (BDE) team and above. Press "Ask the client manager to merge" instead.') };
  if (kind.kind === 'admin') return { kind };
  const allowed = await scopeIds(user, kind, ids);
  if (allowed && ids.some((i) => !allowed.has(i))) return { error: err(403, 'One of these requirements is not in your area.') };
  return { kind };
}

// POST { keptId, extraIds: [..], openings? 'max'|'sum', note? }
async function merge(user, body, { notify = true } = {}) {
  const keptId = String((body && body.keptId) || '');
  const extraIds = [...new Set((Array.isArray(body && body.extraIds) ? body.extraIds : (body && body.extraId ? [body.extraId] : [])).map(String))].filter((i) => i && i !== keptId);
  if (!keptId || !extraIds.length) return err(400, 'Pick the requirement to keep and the requirement to merge into it.');
  const guard = await requireResolver(user, [keptId, ...extraIds]);
  if (guard.error) return guard.error;
  const openings = body && ['max', 'sum'].includes(body.openings) ? body.openings : undefined;
  const data = await D.everything();
  const done = []; const failed = [];
  for (const extraId of extraIds) {
    const c = D.clusterOfJob(data, extraId);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await M.mergeJobs({ keptId, extraId, user, openings, level: c && c.jobIds.includes(keptId) ? c.level : null, reason: clean(body && body.note, 200) || null, notify });
      done.push(r);
    } catch (e) {
      if (!(e instanceof M.JobMergeError)) throw e;
      failed.push({ extraId, error: e.message, code: e.code });
    }
  }
  if (!done.length) return err(failed[0] && /migration|one-time/i.test(failed[0].error) ? 503 : 409, failed[0].error, { failed });
  const people = done.reduce((n, d) => n + d.moved.people + d.moved.folded, 0);
  return out(200, { ok: true, merged: done, failed, message: `Joined. ${people} ${people === 1 ? 'person is' : 'people are'} now on ${done[0].keptCode || 'the kept requirement'}. You can undo this for ${done[0].undoDays} days.` });
}

// POST { jobIds: [a,b,...], reason }  — "Not a duplicate"
async function notDuplicate(user, body) {
  const ids = [...new Set((Array.isArray(body && body.jobIds) ? body.jobIds : []).map(String))];
  if (ids.length < 2) return err(400, 'Pick the requirements that are not duplicates.');
  const reason = clean(body && body.reason, 300);
  if (reason.length < 3) return err(400, 'Write a few words on why these are different requirements.', { field: 'reason' });
  const guard = await requireResolver(user, ids);
  if (guard.error) return guard.error;
  if (!(await D.supported())) return err(503, 'This needs a one-time update of the database. Ask the Super Admin.');
  for (let i = 0; i < ids.length; i += 1) for (let k = i + 1; k < ids.length; k += 1) await D.rememberNotDuplicate(ids[i], ids[k], { reason, user, door: 'Duplicate requirements' }); // eslint-disable-line no-await-in-loop
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'Marked: not a duplicate requirement', entity: 'Requirement', entityId: ids[0], toValue: ids.join(','), reason });
  return out(200, { ok: true, message: 'Saved. These requirements will not be offered as duplicates again.' });
}

// POST { extraId, keptId? }  — "Close the extra only": the extra job has no candidates
async function closeExtra(user, body) {
  const id = String((body && body.extraId) || '');
  if (!id) return err(400, 'Pick the requirement to close.');
  const guard = await requireResolver(user, [id]);
  if (guard.error) return guard.error;
  const job = await prisma.requirement.findUnique({ where: { id } });
  if (!job) return err(404, 'This requirement no longer exists.');
  if (job.status === 'CLOSED') return err(409, 'This requirement is already closed.');
  const st = (await M.statsFor([id]))[id];
  if (st.apps || st.invoices) return err(409, `${job.reqCode || 'This requirement'} has ${st.apps} ${st.apps === 1 ? 'person' : 'people'} on it. Use "Merge into the kept requirement" so nobody is lost.`);
  await prisma.requirement.update({ where: { id }, data: { status: 'CLOSED' } });
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  const keep = body && body.keptId ? await prisma.requirement.findUnique({ where: { id: String(body.keptId) }, select: { reqCode: true } }) : null;
  await logAudit({ userId: user.id, actorName: user.name, action: 'Requirement closed', entity: 'Requirement', entityId: id, fromValue: job.status, toValue: 'CLOSED', reason: `Duplicate requirement closed${keep && keep.reqCode ? ` (kept ${keep.reqCode})` : ''}` });
  try { await require('./jobPosting').autoPost(id, { actorId: user.id, actorName: user.name, trigger: 'status', prevStatus: job.status, background: true }); } catch { /* reported by the posting engine */ } // eslint-disable-line global-require
  D.bump({ hard: true });
  return out(200, { ok: true, message: `${job.reqCode || 'The requirement'} is closed.` });
}

// --- "Merge all obvious ones" -------------------------------------------------------------------------------------
async function autoProposals(user) {
  const kind = actorKind(user);
  if (!kind.view) return err(403, 'Not available to this login.');
  const data = await D.everything();
  const { clusters } = await visibleClusters(user, data);
  const cert = clusters.filter((c) => c.level === 'CERTAIN');
  const st = await M.statsFor([...new Set(cert.flatMap((c) => c.jobIds))]);
  const names = await namesFor(cert.map((c) => ({ jobs: c.jobIds.map((id) => ({ ...((data.byId.get(id) || {}).j || {}), clientId: c.clientId })) })));
  const proposals = cert.map((c) => {
    const sh = shape(c, data.byId, st, names, kind);
    const kept = sh.jobs.find((j) => j.suggestedKeep);
    const extras = sh.jobs.filter((j) => !j.suggestedKeep);
    return {
      clusterId: sh.id, client: sh.client, reasons: sh.reasons, keptId: kept.id, kept: { reqCode: kept.reqCode, title: kept.title, candidates: kept.candidates, openings: kept.openings },
      extras: extras.map((e) => ({ id: e.id, reqCode: e.reqCode, title: e.title, candidates: e.candidates, openings: e.openings })),
      willMove: extras.reduce((n, e) => n + e.candidates, 0), blocked: sh.blocked, canApprove: kind.resolve && !sh.blocked.length,
    };
  }).sort((a, b) => a.client.localeCompare(b.client));
  return out(200, { proposals, canResolve: kind.resolve, total: proposals.length, mergeable: proposals.filter((p) => p.canApprove).length });
}
async function autoApprove(user, body) {
  const kind = actorKind(user);
  if (!kind.resolve) return err(403, 'Merging requirements is for the client manager (BDE) team and above.');
  const want = new Set((Array.isArray(body && body.clusterIds) ? body.clusterIds : []).map(String));
  const all = body && body.all === true;
  if (!want.size && !all) return err(400, 'Pick the ones you approve.');
  const prop = await autoProposals(user);
  if (prop.status !== 200) return prop;
  const todo = prop.body.proposals.filter((p) => p.canApprove && (all || want.has(p.clusterId)));
  if (!todo.length) return err(409, 'Nothing here can be merged any more. Reload the list.');
  const merged = []; const failed = [];
  for (const p of todo) {
    // eslint-disable-next-line no-await-in-loop
    const r = await merge(user, { keptId: p.keptId, extraIds: p.extras.map((e) => e.id), note: 'Merged all obvious duplicates' }, { notify: false });
    if (r.status === 200) merged.push(...r.body.merged); else failed.push({ clusterId: p.clusterId, error: r.body.error });
  }
  const people = merged.reduce((n, d) => n + d.moved.people + d.moved.folded, 0);
  // ONE summary bell per owner (not one per pair)
  try {
    const jobs = await prisma.requirement.findMany({ where: { id: { in: merged.flatMap((m) => [m.keptId, m.extraId]) } } });
    const owners = await M.ownersOf(...jobs);
    for (const o of owners) {
      if (o.id === user.id) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await prisma.notification.create({ data: { userId: o.id, title: 'Duplicate requirements were joined', message: `${user.name} joined ${merged.length} extra ${merged.length === 1 ? 'job' : 'requirements'} into the requirements they copy. ${people} ${people === 1 ? 'person' : 'people'} moved. Open Requirements > Duplicate requirements > Done to see them.
Open: /requirements?tab=duplicates`, channel: 'In-App', recipient: `job-merge-bulk|${Date.now()}|${o.id}`.slice(0, 250), status: 'Sent' } });
    }
  } catch { /* the bell is a courtesy */ }
  return out(200, { ok: true, mergedJobs: merged.length, people, failed, message: `Joined ${merged.length} extra ${merged.length === 1 ? 'job' : 'requirements'}. ${people} ${people === 1 ? 'person' : 'people'} moved. You can undo each for ${(await D.settings()).undoDays} days.` });
}

async function undo(user, id) {
  const kind = actorKind(user);
  if (!kind.resolve) return err(403, 'Undo is for the client manager (BDE) team and above.');
  const log = await M.mergeLogOf(id);
  if (!log) return err(404, 'This merge is not on record.');
  const guard = await requireResolver(user, [log.keptId, log.extraId]);
  if (guard.error) return guard.error;
  try {
    const r = await M.undoMerge(id, user);
    return out(200, { ok: true, ...r, message: 'Undone. The two requirements are back as they were.' });
  } catch (e) {
    if (e instanceof M.JobMergeError) return err(e.status, e.message);
    throw e;
  }
}

// --- the small note on a job (TL / Recruiter / Manager) and the "Ask the client manager to merge" button ------------------
// GET /job/:id -> { twin: bool, count, with: [{ id, reqCode, title }], canResolve, canAsk, asked }
async function noteFor(user, jobId) {
  const kind = actorKind(user);
  const empty = { twin: false, count: 0, with: [], canResolve: kind.resolve, canAsk: false, asked: false };
  if (!kind.view && !kind.ask) return out(200, empty);
  const data = await D.everything();
  const c = D.clusterOfJob(data, jobId);
  if (!c || c.level === 'POSSIBLE') return out(200, empty);
  const others = c.jobIds.filter((i) => i !== jobId).map((i) => (data.byId.get(i) || {}).j).filter(Boolean);
  let asked = false;
  if (kind.ask) {
    const prior = await prisma.auditLog.findFirst({ where: { action: ASK_ACTION, entityId: jobId, userId: user.id, createdAt: { gte: new Date(Date.now() - D.DAY) } }, select: { id: true } });
    asked = !!prior;
  }
  return out(200, { twin: true, level: c.level, count: others.length, with: others.slice(0, 3).map((j) => ({ id: j.id, reqCode: j.reqCode, title: j.title })), canResolve: kind.resolve, canAsk: kind.ask && !kind.resolve, asked });
}
const ASK_ACTION = 'Requirement merge asked';
async function askMerge(user, body) {
  const kind = actorKind(user);
  if (!kind.ask) return err(403, 'Only the client manager (BDE) team merges requirements.');
  const jobId = String((body && body.jobId) || '');
  const job = await prisma.requirement.findUnique({ where: { id: jobId }, include: { client: true } });
  if (!job) return err(404, 'This requirement no longer exists.');
  const where = SC.requirementWhere(user);
  if (!SC.matches(job, where)) return err(403, SC.OUT_OF_SCOPE.error || 'This requirement is not in your area.');
  const prior = await prisma.auditLog.findFirst({ where: { action: ASK_ACTION, entityId: jobId, userId: user.id, createdAt: { gte: new Date(Date.now() - D.DAY) } }, select: { id: true } });
  if (prior) return out(200, { ok: true, already: true, message: 'You already asked today. The client manager has it.' });
  const data = await D.everything();
  const c = D.clusterOfJob(data, jobId);
  const twins = c ? c.jobIds.filter((i) => i !== jobId).map((i) => (data.byId.get(i) || {}).j).filter(Boolean) : [];
  const to = await require('./interviewRequest').recipientsFor(job); // eslint-disable-line global-require
  const people = to.ids.length ? await prisma.user.findMany({ where: { id: { in: to.ids }, status: 'Active' }, select: { id: true, name: true } }) : [];
  const who = people.filter((p) => p.id !== user.id);
  const note = clean(body && body.note, 300);
  const title = `Two copies of a requirement: ${job.reqCode || job.title}`;
  const message = `${user.name} thinks ${job.reqCode || ''} ${job.title}${job.client ? ` (${job.client.name})` : ''} is the same requirement as ${twins.map((t) => t.reqCode || t.title).slice(0, 3).join(', ') || 'another one'}. Please check and merge them.${note ? ` Note: ${note}` : ''}\nOpen: /requirements?tab=duplicates`;
  for (const p of who) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.notification.create({ data: { userId: p.id, title, message, channel: 'In-App', recipient: `job-merge-ask|${jobId}|${p.id}`.slice(0, 250), status: 'Sent' } });
  }
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: ASK_ACTION, entity: 'Requirement', entityId: jobId, toValue: twins.map((t) => t.reqCode || t.id).join(','), reason: note || undefined });
  return out(200, { ok: true, notified: who.length, message: who.length ? 'Asked. The client manager will check.' : 'Saved. No client manager is named for this client yet.' });
}

// POST /check — the live check while the Add job form is filled (the same rule the save uses)
async function checkDraft(user, body) {
  const kind = actorKind(user);
  const ok = kind.resolve || ['manager', 'am'].includes(kind.kind) || JC.canCreateJob(user, {}).allowed;
  if (!ok) return err(403, 'Not available to this login.');
  const m = await require('./jobDupGuard').cardFor(body || {}, { user }); // eslint-disable-line global-require
  return out(200, { matches: m });
}

// POST /add-openings { jobId, add, note } — "Add openings to the existing job"
async function addOpenings(user, body) {
  const kind = actorKind(user);
  if (!kind.resolve && !JC.canCreateJob(user, {}).allowed) return err(403, 'Adding openings is for the client manager (BDE) team and above.');
  const jobId = String((body && body.jobId) || '');
  const add = Math.max(1, Math.min(500, Number(body && body.add) || 1));
  const job = await prisma.requirement.findUnique({ where: { id: jobId } });
  if (!job) return err(404, 'This requirement no longer exists.');
  if (kind.kind !== 'admin' && !SC.matches(job, SC.requirementWhere(user))) return err(403, 'This requirement is not in your area.');
  if (job.status === 'CLOSED') return err(409, 'This requirement is closed. Open it again first, or create it anyway as a new requirement.');
  const from = Number(job.openings || 1);
  await prisma.requirement.update({ where: { id: jobId }, data: { openings: from + add } });
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'Openings added to existing requirement', entity: 'Requirement', entityId: jobId, fromValue: String(from), toValue: String(from + add), reason: clean(body && body.note, 200) || 'Asked for the same requirement again; the openings were added instead of a second requirement' });
  D.bump({ hard: true });
  return out(200, { ok: true, id: jobId, reqCode: job.reqCode, openings: from + add, message: `Done. ${job.reqCode || 'The requirement'} now has ${from + add} openings.` });
}

async function getSettings(user) {
  const kind = actorKind(user);
  if (!kind.view) return err(403, 'Not available to this login.');
  return out(200, { ...(await D.settings()), supported: await D.supported() });
}
async function setSettings(user, body) {
  const kind = actorKind(user);
  if (kind.kind !== 'admin') return err(403, 'Only a Super Admin or Admin can change this.');
  const patch = {};
  if (body && body.undoDays != null) patch.undoDays = Math.min(60, Math.max(1, Number(body.undoDays) || 7));
  if (body && ['max', 'sum'].includes(body.openings)) patch.openings = body.openings;
  const next = await D.saveSettings(patch, user);
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, actorName: user.name, action: 'Duplicate requirement settings changed', entity: 'AppSetting', entityId: 'job-duplicates', toValue: JSON.stringify(next) });
  return out(200, next);
}

module.exports = {
  actorKind, status, worklist, merge, notDuplicate, closeExtra, autoProposals, autoApprove, undo, mergesList, noteFor, askMerge, checkDraft, addOpenings,
  getSettings, setSettings, isSuper, clusterIdOf, shape, namesFor, suggestKept,
};
