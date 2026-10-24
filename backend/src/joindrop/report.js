// ---------------------------------------------------------------------------
// JOINING & DROP - THE LIST, THE REPORT, THE CSV.
//
//   list()    the Joining screen's "Joined and dropped" list: one row per joining with the dates (joined, journey key dates), place, client,
//             job, recruiter, status, days since joining, the guarantee (until + how), replacement status; filters that cascade (a
//             department narrows the client / recruiter lists) with counts; paged.
//   report()  the small report: joined, dropped, drop rate, inside the guarantee, replacements asked / delivered / not needed, top reasons, by
//             client / recruiter / department / month.
//   csv()     both as CSV (the caller checked the export right and writes the Audit Log). Pay only where the viewer may see pay; never a phone
//             or an email address (a record has none).
//
// Only records the login may open are counted (access.visible), so a number is never a peek at another desk.
// ---------------------------------------------------------------------------
const S = require('./schema');
const V = require('./vocab');
const A = require('./access');
const JR = require('./journey');

const lc = (s) => String(s || '').trim().toLowerCase();
const isTestName = (s) => !require('../utils/sandbox').isSandbox() && /zztest|example\.test/i.test(String(s || '')); // eslint-disable-line global-require

async function allVisible(user, rt) {
  const rows = await S.rows('SELECT * FROM "JoiningRecord" ORDER BY COALESCE("joinedOn", \'\') DESC, "createdAt" DESC');
  const vis = await A.visible(user, rows.filter((r) => !isTestName(r.candidateName)), rt);
  return vis;
}

function inRange(day, from, to) {
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// q: { q, from, to, clientId, recruiter, department, status, reason, within, replacement, needs, page, pageSize }
function applyFilters(rows, q, { skip = [] } = {}) {
  const f = (key, fn) => (skip.includes(key) ? (x) => x : fn);
  let out = rows;
  if (q.q && !skip.includes('q')) {
    const n = lc(q.q);
    out = out.filter((r) => `${r.candidateName} ${r.jobTitle} ${r.clientName} ${r.location} ${r.recruiterName} ${r.dropReason}`.toLowerCase().includes(n));
  }
  out = f('range', (x) => x.filter((r) => (q.from || q.to ? inRange(r.joinedOn, q.from, q.to) : true)))(out);
  if (q.department && !skip.includes('department')) out = out.filter((r) => lc(r.department) === lc(q.department));
  if (q.clientId && !skip.includes('clientId')) out = out.filter((r) => r.clientId === q.clientId);
  if (q.recruiter && !skip.includes('recruiter')) out = out.filter((r) => r.recruiterUserId === q.recruiter || lc(r.recruiterName) === lc(q.recruiter));
  if (q.status === 'Joined' || q.status === 'Dropped') out = out.filter((r) => r.status === q.status);
  if (q.reason) out = out.filter((r) => lc(r.dropReason) === lc(q.reason));
  if (q.within === 'yes') out = out.filter((r) => r.status === 'Dropped' && r.dropWithinGuarantee === 1);
  if (q.within === 'no') out = out.filter((r) => r.status === 'Dropped' && r.dropWithinGuarantee === 0);
  if (q.within === 'running') out = out.filter((r) => r.status === 'Joined' && r.guaranteeEndsOn && V.todayIst() <= r.guaranteeEndsOn);
  if (q.replacement === 'waiting') out = out.filter((r) => r.status === 'Dropped' && !r.replacementDecision);
  else if (q.replacement) out = out.filter((r) => r.replacementStatus === q.replacement);
  if (q.needs === 'yes') out = out.filter((r) => !r.joinedOn || !r.location);
  return out;
}

const countBy = (rows, key) => {
  const m = new Map();
  rows.forEach((r) => { const k = r[key]; if (k == null || k === '') return; m.set(k, (m.get(k) || 0) + 1); });
  return m;
};

async function list(user, q = {}) {
  const rt = await A.rights(user);
  if (!['admin', 'mgmt', 'tl', 'stl', 'recruiter', 'bde', 'hr', 'accounts', 'client'].includes(rt.kind)) return { rows: [], total: 0, counts: {}, facets: {}, rights: rt };
  const all = await allVisible(user, rt);
  const base = applyFilters(all, q, { skip: [] });
  const status = q.view === 'Joined' || q.view === 'Dropped' ? q.view : null;
  const shown = status ? base.filter((r) => r.status === status) : base;
  // facets: each list is narrowed by the OTHER filters (department -> client / recruiter), with counts
  const deptRows = applyFilters(all, q, { skip: ['department', 'clientId', 'recruiter'] });
  const deptOpts = [...countBy(deptRows, 'department').entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  const narrowed = applyFilters(all, q, { skip: ['clientId', 'recruiter'] });
  const clientCounts = new Map();
  narrowed.forEach((r) => { if (r.clientId) clientCounts.set(r.clientId, { value: r.clientId, label: r.clientName, count: ((clientCounts.get(r.clientId) || {}).count || 0) + 1 }); });
  const recCounts = new Map();
  narrowed.forEach((r) => { const k = r.recruiterUserId || r.recruiterName; if (k) recCounts.set(k, { value: k, label: r.recruiterName || k, count: ((recCounts.get(k) || {}).count || 0) + 1 }); });
  const reasons = [...countBy(applyFilters(all, { ...q, reason: '' }), 'dropReason').entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  const counts = {
    all: base.length, Joined: base.filter((r) => r.status === 'Joined').length, Dropped: base.filter((r) => r.status === 'Dropped').length,
    needsDecision: base.filter((r) => r.status === 'Dropped' && !r.replacementDecision).length,
    needsDetails: base.filter((r) => !r.joinedOn || !r.location).length,
  };
  const size = Math.min(200, Math.max(5, Number(q.pageSize) || 25));
  const page = Math.max(1, Number(q.page) || 1);
  const slice = shown.slice((page - 1) * size, page * size);
  const keys = rt.kind === 'client' ? new Map() : await JR.keyDates(slice.map((r) => r.applicationId));
  const tasks = await A.taskStates(slice.map((r) => r.replacementTaskId));
  const rows = slice.map((r) => ({ ...A.shape(r, rt, { tasks }), ...(rt.kind === 'client' ? {} : { journey: keys.get(r.applicationId) || null }) }));
  return {
    rows, total: shown.length, page, pageSize: size, counts,
    facets: { departments: deptOpts, clients: await require('../utils/clientLocations').labelClientOptions([...clientCounts.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)))), // eslint-disable-line global-require
 recruiters: [...recCounts.values()].sort((a, b) => String(a.label).localeCompare(String(b.label))), reasons },
    rights: { kind: rt.kind, record: rt.record, report: rt.report, export: rt.export, seePay: rt.seePay },
  };
}

// ---- the report ----------------------------------------------------------------------------------------------------------------------
function tally(rows) {
  const joined = rows.length;
  const dropped = rows.filter((r) => r.status === 'Dropped');
  const within = dropped.filter((r) => r.dropWithinGuarantee === 1).length;
  const asked = dropped.filter((r) => r.replacementDecision === 'NEEDED').length;
  return {
    joined, dropped: dropped.length, dropRate: joined ? Math.round((dropped.length / joined) * 1000) / 10 : 0, withinGuarantee: within,
    replacementsRequested: asked, replacementsDelivered: dropped.filter((r) => r.replacementStatus === V.REPL.CLOSED).length,
    replacementsNotNeeded: dropped.filter((r) => r.replacementDecision === 'NOT_NEEDED').length,
    waitingForClient: dropped.filter((r) => !r.replacementDecision).length,
    dropAfterIncentive: dropped.filter((r) => r.dropAfterIncentive).length,
  };
}

async function report(user, q = {}) {
  const rt = await A.rights(user);
  const all = await allVisible(user, rt);
  const rows = applyFilters(all, q);
  const groupKey = ['client', 'recruiter', 'department', 'month'].includes(q.groupBy) ? q.groupBy : 'client';
  const keyOf = (r) => ({ client: r.clientName, recruiter: r.recruiterName, department: r.department, month: r.joinedOn ? r.joinedOn.slice(0, 7) : null }[groupKey]) || 'Not recorded';
  const groups = new Map();
  rows.forEach((r) => { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const by = [...groups.entries()].map(([name, list]) => ({ name, ...tally(list) })).sort((a, b) => (groupKey === 'month' ? b.name.localeCompare(a.name) : b.joined - a.joined || a.name.localeCompare(b.name)));
  const reasonMap = countBy(rows.filter((r) => r.status === 'Dropped'), 'dropReason');
  const dropsInPeriod = all.filter((r) => r.status === 'Dropped' && (q.from || q.to ? inRange(r.droppedOn, q.from, q.to) : true) && (!q.department || lc(r.department) === lc(q.department)) && (!q.clientId || r.clientId === q.clientId)).length;
  return {
    period: { from: q.from || null, to: q.to || null },
    groupBy: groupKey,
    totals: { ...tally(rows), droppedInPeriod: dropsInPeriod },
    by,
    topReasons: [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
    note: 'Joined = people whose joining day is in the period. Drop rate = how many of them have dropped. Recruiter joinings for incentives are counted on their own screen and are not changed by a drop.',
    rights: { kind: rt.kind, export: rt.export },
  };
}

// ---- CSV -----------------------------------------------------------------------------------------------------------------------------
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never a formula in a spreadsheet
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function csvRows(user, q = {}) {
  const rt = await A.rights(user);
  const all = await allVisible(user, rt);
  const rows = applyFilters(all, q);
  const status = q.view === 'Joined' || q.view === 'Dropped' ? q.view : null;
  const list = status ? rows.filter((r) => r.status === status) : rows;
  const keys = rt.kind === 'client' ? new Map() : await JR.keyDates(list.map((r) => r.applicationId));
  const staff = rt.kind !== 'client';
  const head = ['Candidate', 'Client', 'Requirement', ...(staff ? ['Department'] : []), 'Status', 'Joined on', 'Place', 'Designation', 'Days since joining',
    'Replacement period ends', 'Replacement period days', 'How the period was decided', 'Dropped on', 'Last working day', 'Reason', 'Reason details', 'Dropped inside the period',
    ...(staff ? ['Reported by', 'Reported from'] : []), 'Replacement decision', 'Replacement status',
    ...(staff ? ['Recruiter', 'TL', 'BDE', 'Came to us on', 'Reached BDE on', 'Sent to client on', 'First interview on', 'Offer made on', 'Offer accepted on'] : []),
    ...(rt.seePay ? ['Pay (CTC)'] : [])];
  const out = [head.map(cell).join(',')];
  list.forEach((r) => {
    const s = A.shape(r, rt);
    const k = keys.get(r.applicationId) || {};
    out.push([
      s.candidateName, s.clientName, s.jobTitle, ...(staff ? [s.department] : []), s.status, s.joinedOn || 'Not recorded', s.location || 'Not recorded', s.designation, s.daysSinceJoining,
      s.guaranteeEndsOn, s.guaranteeDays, s.guaranteeSourceWords, s.droppedOn, s.lastWorkingDay, s.dropReason, s.dropReasonDetail,
      s.status === 'Dropped' ? (s.dropWithinGuarantee === 1 ? 'Yes' : (s.dropWithinGuarantee === 0 ? 'No' : 'Not known')) : '',
      ...(staff ? [s.dropReportedByName, s.dropReportedFrom] : []), s.replacementDecisionWords, s.replacementStatus,
      ...(staff ? [s.recruiterName, s.tlName, s.bdeName, k.cameOn || 'Not recorded', k.bdeOn || 'Not recorded', k.sentToClientOn || 'Not recorded', k.firstInterviewOn || 'Not recorded', k.offerOn || 'Not recorded', k.offerAcceptedOn || 'Not recorded'] : []),
      ...(rt.seePay ? [s.offeredCtc] : []),
    ].map(cell).join(','));
  });
  return { csv: `${out.join('\r\n')}\r\n`, count: list.length };
}

async function reportCsv(user, q = {}) {
  const r = await report(user, q);
  const head = ['Group', 'Joined', 'Dropped', 'Drop rate %', 'Dropped inside the period', 'Replacements asked', 'Replacements delivered', 'No replacement needed', 'Waiting for the client'];
  const lines = [head.map(cell).join(',')];
  [{ name: 'ALL', ...r.totals }, ...r.by].forEach((g) => lines.push([g.name, g.joined, g.dropped, g.dropRate, g.withinGuarantee, g.replacementsRequested, g.replacementsDelivered, g.replacementsNotNeeded, g.waitingForClient].map(cell).join(',')));
  lines.push('', ['Top reasons', 'Count'].map(cell).join(','));
  r.topReasons.forEach((t) => lines.push([t.reason, t.count].map(cell).join(',')));
  return { csv: `${lines.join('\r\n')}\r\n` };
}

module.exports = { list, report, csvRows, reportCsv, applyFilters, allVisible, tally };
