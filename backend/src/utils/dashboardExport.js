// ---------------------------------------------------------------------------
// THE DASHBOARDS' EXPORT BUTTON (user, 2026-10-09: "dashboard lo export
// button") — one file of what is on the screen, for the filters picked.
//
//   atsHomeBook(user, board)   the ATS dashboard (utils/atsHome.js board)
//   hrmsBook(...)              the HRMS dashboard   (routes/hrmsDashboard.js)
//   accountsBook(data)         the Accounts dashboard (utils/accountsControl.js)
//
// Each returns { sheets: [{ name, headers, rows }] } for exportKit.sendBook.
// Nothing is computed twice: the books are written from the SAME payload the
// screen was drawn from, so a tile and its number in the file cannot differ.
// WHO may export and which rows they may see is decided by the routes (the
// export right, the role's scope); this file only lays the numbers out.
//
// Sheet 1 is always "Summary": Section · Item · Value · Note — every tile and
// every chart number. The lists behind the numbers come after it.
// ---------------------------------------------------------------------------

const LIST_CAP = 10000; // rows of one list in one file (the Summary says so when cut)
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' ? '' : Number(v));
const dayOf = (v) => (v ? String(v).slice(0, 10) : '');

// Rows of the Summary sheet.
function summaryBuilder() {
  const rows = [];
  const add = (section, item, value, note = '') => rows.push([section, item, value === undefined || value === null ? '' : value, note || '']);
  return { rows, add, sheet: () => ({ name: 'Summary', headers: ['Section', 'Item', 'Value', 'Note'], rows }) };
}

// The sheet of one kind of list, from atsHome's own export columns.
function listSheet(H, name, list) {
  const t = H.exportTable(list);
  const cut = t.rows.length > LIST_CAP;
  return { sheet: { name, headers: t.headers, rows: cut ? t.rows.slice(0, LIST_CAP) : t.rows }, cut, total: t.rows.length };
}

// ===========================================================================
// ATS
// ===========================================================================
const LEAD_LAYOUTS = ['superadmin', 'admin', 'manager', 'asstmanager', 'stl'];

// The six tiles the screen draws (components/dashboard/ats-v4/AtsV4.jsx buildTiles).
function atsTiles(b) {
  const ws = arr(b.widgets);
  const kpi = ws.find((w) => w.type === 'kpis');
  const L = b.layout;
  const g = b.greeting;
  const gItem = (id) => (g && Array.isArray(g.items) ? ((g.items.find((i) => i.id === id) || {}).value || 0) : null);
  let tiles = kpi ? arr(kpi.tiles).slice() : [];
  const has = (id) => tiles.some((t) => t.id === id);
  if (kpi && tiles.length < 6) {
    if (LEAD_LAYOUTS.includes(L) && !has('client-feedback')) {
      const v = gItem('client-feedback');
      if (v !== null) {
        const at = Math.max(0, tiles.findIndex((t) => t.id === 'interviews') + 1) || tiles.length;
        tiles.splice(at, 0, { id: 'client-feedback', label: 'Client has not replied', value: v, drill: 'client-feedback', zero: 'Every client has replied' });
      }
    } else if (L === 'tl' && !has('overdue')) {
      const v = gItem('late');
      if (v !== null) tiles.push({ id: 'overdue', label: 'Late', value: v, drill: 'overdue', zero: 'Nothing is late' });
    } else if (L === 'bde' && !has('agreement-pending')) {
      const u = ws.find((w) => w.id === 'unsigned' && w.type === 'clients');
      if (u) tiles.push({ id: 'agreement-pending', label: 'Unsigned agreements', value: u.total, drill: u.drill, zero: 'All agreements are signed' });
    }
  }
  if (!kpi && L === 'recruiter') {
    const by = (id) => ws.find((w) => w.id === id);
    const t = by('tasks'); const iv = by('iv-today'); const fb = by('feedback'); const jobs = by('jobs'); const tg = by('target');
    tiles = [
      t && { id: 'my-action', label: 'My tasks', value: Number(t.more) || 0, drill: t.drill, zero: 'No open tasks' },
      t && { id: 'tasks-today', label: 'Due today', value: t.total, zero: 'Nothing due today' },
      iv && { id: 'iv-today', label: 'Interviews today', value: iv.total, drill: iv.drill, zero: iv.zero },
      fb && { id: 'feedback', label: 'Interview done, no feedback', value: fb.total, drill: fb.drill, zero: fb.zero },
      jobs && { id: 'my-jobs', label: 'My open requirements', value: jobs.total, drill: jobs.drill, zero: jobs.zero },
      tg && { id: 'my-joins', label: 'Joinings this month', value: tg.value, drill: tg.drill, zero: tg.zero, sub: tg.target ? `of ${tg.target} target` : null },
    ].filter(Boolean);
  }
  return tiles;
}

// "Needs attention" as the screen builds it (AtsV4.jsx attentionOf).
function atsAttention(b) {
  const ws = arr(b.widgets);
  const L = b.layout;
  const out = [];
  const it = (label, count, sub, drill) => out.push({ label, count, sub, drill });
  const lines = ws.find((w) => w.type === 'lines');
  if (lines) arr(lines.lines).forEach((l) => it(l.label, l.count, l.sub, l.drill));
  else if (L === 'tl' && b.greeting && Array.isArray(b.greeting.items)) b.greeting.items.forEach((i) => it(i.label, i.value, null, i.drill));
  else if (L === 'recruiter') {
    const by = (id) => ws.find((w) => w.id === id);
    const t = by('tasks'); const fb = by('feedback'); const iv = by('iv-today');
    if (t && t.total) it('Tasks due today', t.total, 'Late steps and calls due today', t.drill);
    if (fb && fb.total) it(fb.title, fb.total, "Waiting for the client's reply", fb.drill);
    if (iv && iv.total) it(iv.title, iv.total, null, iv.drill);
  } else if (L === 'bde') {
    const fb = ws.find((w) => w.id === 'client-fb'); const un = ws.find((w) => w.id === 'unsigned');
    if (fb && fb.total) it(fb.title, fb.total, 'Sent to the client, no reply yet', fb.drill);
    if (un && un.total) it('Clients with unsigned agreement', un.total, 'Open requirements, agreement not signed', un.drill);
  }
  arr(b.extras).filter((x) => x && !x.button && x.value > 0).forEach((x) => it(x.label, x.value, null, x.drill));
  return { items: out, more: lines ? Number(lines.more) || 0 : 0 };
}

function filterRows(b) {
  const opts = b.filterOptions || {};
  const labelOf = (k, v) => ((arr(opts[k]).find((o) => String(o.value) === String(v)) || {}).label) || v;
  const names = {
    department: 'Department', clientId: 'Client', tl: 'Team lead', recruiter: 'Recruiter', bde: 'Client manager (BDE)', requirementId: 'Requirement', hiring: 'Hiring type', priority: 'Priority', source: 'Source',
  };
  const out = [];
  const p = b.period || {};
  out.push(['Date range', p.key === 'all' ? 'Any time' : (p.word ? `${p.word} (${p.from} to ${p.to})` : `${p.from} to ${p.to}`)]);
  Object.entries(b.filters || {}).forEach(([k, v]) => {
    out.push([names[k] || k, k === 'department' && v === '__none__' ? 'No department' : labelOf(k, v)]);
  });
  if (out.length === 1) out.push(['Other filters', 'None - everything in your area']);
  return out;
}

async function atsHomeBook(user, b) {
  // eslint-disable-next-line global-require
  const H = require('./atsHome');
  const S = summaryBuilder();
  const ws = arr(b.widgets);
  const sheets = [];
  const notes = [];
  const p = b.period || {};

  S.add('About', 'Dashboard', b.title || 'ATS Dashboard', b.about || '');
  S.add('About', 'Your area', b.scopeChip || '', '');
  S.add('About', 'Department', b.department || 'All departments');
  S.add('About', 'Dates', p.key === 'all' ? 'Any time' : `${p.from} to ${p.to}`, p.word || '');
  S.add('About', 'Numbers as of', b.asOf ? String(b.asOf).slice(0, 19).replace('T', ' ') : '', 'Server time');
  S.add('About', 'What the table columns count', 'As of today / the dates / in total', 'Open requirements, In process, Selected and Late are as of today. Interviews and Joined (the dates) follow the date range. Joined (in total) is everyone marked Joined, whatever the joining date.');

  const tiles = atsTiles(b);
  tiles.forEach((t) => {
    const d = t.delta && t.delta.dir !== 'same' ? t.delta.text : '';
    S.add('Numbers', t.label, num(t.value), [t.value ? t.sub : t.zero, d].filter(Boolean).join(' - '));
  });

  const att = atsAttention(b);
  att.items.forEach((i) => S.add('Needs attention', i.label, num(i.count), i.sub || ''));
  if (!att.items.length) S.add('Needs attention', 'Nothing needs attention', 0, '');
  if (att.more) S.add('Needs attention', 'Smaller items not listed', att.more, '');

  // ---- the charts and panels' numbers ----
  ws.forEach((w) => {
    if (w.type === 'money') arr(w.rows).forEach((r) => S.add(w.title || 'Money', r.label, num(r.value), [r.value ? r.sub : r.zero, r.delta && r.delta.dir !== 'same' ? r.delta.text : ''].filter(Boolean).join(' - ')));
    if (w.type === 'funnel') arr(w.rows).forEach((r) => S.add(`${w.title || 'Hiring progress'} (people added ${w.period || ''})`.replace(/\s+\)/, ')'), r.label, num(r.value), r.pct != null ? `${r.pct}% of people added` : ''));
    if (w.type === 'line') arr(w.points).forEach((pt) => S.add(w.title || 'Joinings', pt.label, num(pt.value), ''));
    if (w.type === 'today') arr(w.items).forEach((i) => S.add(w.title || 'Today', i.label, num(i.value), i.hint || ''));
    if (w.type === 'target') S.add(w.title || 'Target', 'Done', num(w.value), w.target ? `Target ${w.target}` : (w.noTarget || ''));
    if (w.type === 'cleanup') {
      S.add('Data cleanup', `Not moving (${w.days}+ days)`, num(w.stale), '');
      S.add('Data cleanup', 'Old requirements, no recruiter', num(w.oldUnassigned), '');
      if (w.joinedNoDate) S.add('Data cleanup', 'Joined, no joining date', num(w.joinedNoDate), 'In the Joined total, in no month');
      if (w.joinedWrongDate) S.add('Data cleanup', 'Joining date looks wrong', num(w.joinedWrongDate), 'A year like 2203 or 1954');
      if (w.health) S.add('Data cleanup', 'System problems', num(w.health.problems), '');
    }
    if (w.type === 'banner') S.add('Activity', 'Activity not logged', '', w.text || '');
  });

  // ---- Departments table ----
  const tlsList = ws.some((w) => w.type === 'tls') && b.kx ? await H.homeList(user, b, '__tls', {}).catch(() => null) : null;
  // The table says what each column counts (as of today / the dates picked / in total),
  // the same words as the screen (backend atsHome departmentsTable / departmentsV3 columns).
  const depts = ws.find((w) => w.type === 'depts' || w.type === 'depts3');
  if (depts) {
    const withTl = depts.type === 'depts';
    const tlCount = (d) => {
      const g = tlsList && arr(tlsList.groups).find((x) => x.department === (d || 'No department'));
      return g ? g.rows.length : 0;
    };
    const cols = arr(depts.columns);
    const head = (c) => `${c.label} (${c.basis})`;
    const rowsOut = arr(depts.rows).map((r) => [r.fixNeeded ? 'No department' : r.department, ...cols.map((c) => num(r[c.key])), ...(withTl ? [tlCount(r.department)] : [])]);
    // The last row: the departments added up (= the tiles / the Candidates strip).
    if (depts.totals) rowsOut.push(['All departments', ...cols.map((c) => num(depts.totals[c.key])), ...(withTl ? [arr(tlsList && tlsList.rows).length || ''] : [])]);
    sheets.push({
      name: 'Departments',
      headers: ['Department', ...cols.map(head), ...(withTl ? ['Team leads'] : [])],
      rows: rowsOut,
    });
  }
  {
    const jn = (depts && depts.joinNote) || b.joinFigures;
    if (jn && jn.total) {
      S.add('Joined people', 'Marked Joined, in total', num(jn.total), 'Everyone marked Joined, whatever the joining date (= Joined in total in the Departments sheet)');
      S.add('Joined people', 'Marked Joined, no joining date', num(jn.noDate), 'In the total but in no month; nobody has typed a date');
      S.add('Joined people', 'Joining date looks wrong', num(jn.wrong), 'A year like 2203 or 1954 is not a date; such a person is in no month unless another day is recorded');
      S.add('Joined people', 'Day taken from when they were moved to Joined', num(jn.moved), 'No joining date typed; counted in the month they were moved to Joined');
    }
  }
  // ---- Team leads (and their recruiters) ----
  if (tlsList && arr(tlsList.rows).length) {
    const cols = ['openJobs', 'inProcess', 'interviews', 'selected', 'joined', 'joinedTotal', 'late'];
    const TLH = ['Open requirements (as of today)', 'In process (as of today)', `Interviews (${p.word || 'in the dates picked'})`, 'Selected (as of today)', `Joined (${p.word || 'in the dates picked'})`, 'Joined (in total)', 'Late (as of today)'];
    sheets.push({
      name: 'Team leads',
      headers: ['Team lead', 'Department', 'Recruiters', ...TLH],
      rows: tlsList.rows.map((r) => [r.name, r.department || '', num(r.teamSize), ...cols.map((k) => num(r[k]))]),
    });
    const recs = tlsList.rows.flatMap((r) => arr(r.recruiters).map((x) => [x.name, r.name, ...cols.map((k) => num(x[k]))]));
    if (recs.length) sheets.push({ name: 'Recruiters', headers: ['Recruiter', 'Team lead', ...TLH], rows: recs });
  }
  // ---- Waiting work ----
  const people = ws.find((w) => w.type === 'people');
  if (people && arr(people.rows).length) {
    sheets.push({
      name: 'Waiting work',
      headers: [people.who || 'Person', 'Waiting', 'Due today', 'Late'],
      rows: people.rows.map((r) => [r.name, num(r.pending), num(r.dueToday), num(r.overdue)]),
    });
  }
  // ---- Open jobs (all of them, the screen shows the top few) ----
  let jobsSheet = false;
  if (ws.some((w) => w.type === 'openjobs') && b.kx) {
    const jobs = await H.homeList(user, b, '__jobs', { d_size: 100 }).catch(() => null);
    if (jobs && jobs.total) { const l = listSheet(H, 'Open requirements', { kind: 'jobs', _all: jobs._all }); sheets.push(l.sheet); jobsSheet = true; if (l.cut) notes.push(['Open requirements', l.total]); }
  }

  // ---- the lists behind the numbers ----
  const seen = new Set(jobsSheet ? ['open-jobs'] : []); // the Open jobs sheet above already has every open job
  const want = [];
  const take = (id, title) => { if (id && !seen.has(id) && b.sets && b.sets.has(id)) { seen.add(id); want.push([id, title]); } };
  tiles.forEach((t) => take(t.drill, t.label));
  att.items.forEach((i) => take(i.drill, i.label));
  // The people behind the Joined numbers that the date cannot place (kept out of every month).
  const jf = b.joinFigures;
  if (jf) {
    if (depts) take('joined-total', 'Joined in total');
    if (jf.noDate) take('joined-nodate', 'Joined - no joining date');
    if (jf.wrong) take('joined-wrongdate', 'Joined - date looks wrong');
  }
  ws.forEach((w) => {
    if (w.type === 'money') arr(w.rows).forEach((r) => take(r.drill, r.label));
    if (['list', 'review', 'tasks', 'jobs', 'clients', 'target'].includes(w.type)) take(w.drill, w.title);
  });
  // eslint-disable-next-line no-restricted-syntax
  for (const [id, title] of want) {
    // eslint-disable-next-line no-await-in-loop
    const list = await H.homeList(user, b, id, {}).catch(() => null);
    if (list && list._all && list._all.length) {
      const l = listSheet(H, String(title || list.title).slice(0, 31), list);
      sheets.push(l.sheet);
      if (l.cut) notes.push([title || list.title, l.total]);
    }
  }
  notes.forEach(([n, total]) => S.add('About', 'List cut short', LIST_CAP, `"${n}" has ${total} rows; the first ${LIST_CAP} are in the file. Narrow the filters to get the rest.`));

  sheets.unshift(S.sheet());
  sheets.push({ name: 'Filters used', headers: ['Filter', 'Value'], rows: filterRows(b) });
  return { sheets, tiles: tiles.length };
}

// ===========================================================================
// HRMS
// ===========================================================================
const FILTER_NAMES = { department: 'Department', location: 'Location', status: 'Employee status', designation: 'Designation', manager: 'Reporting manager', q: 'Search' };

// d = the dashboard payload; lists = [{ name, columns, rows }] built by the route
// (the same lists the tiles open); query = the filters.
function hrmsBook({ d, lists, query, managerName }) {
  const S = summaryBuilder();
  const eo = d.employeeOverview; const ao = d.attendanceOverview; const lo = d.leaveOverview; const pt = d.pendingTasks; const p = d.period;
  S.add('About', 'Dashboard', 'HRMS Dashboard');
  S.add('About', 'Date range', p.name, `${p.from} to ${p.to}`);
  S.add('About', 'Attendance day', ao.asOf, 'The last day of the range (today when the range runs on)');
  S.add('About', 'Numbers as of', d.date, '');
  const emp = (item, v, note) => S.add('Employee overview (now)', item, num(v), note);
  emp('Total employees', eo.total, 'Does not count the system Super Admin account');
  emp('Active', eo.active); emp('Serving notice', eo.servingNotice); emp('Exit process', eo.exitProcess);
  emp('Left', eo.left, `Relieved ${eo.relieved} - Exited ${eo.exited}`);
  if (eo.other) emp('Other status', eo.other, (eo.otherStatuses || []).join(', '));
  S.add(`New joiners - ${p.name}`, 'New joiners', num(eo.newJoiners), 'Joining date inside the range');
  S.add(`New joiners - ${p.name}`, 'Leave approved for this date', num(eo.onLeave), 'Approved leave in the range');
  const att = (item, v, note) => S.add(`Attendance on ${ao.asOf}`, item, num(v), note);
  att('Headcount on the rolls', ao.headcount); att('Present (incl. late)', ao.present); att('Half day', ao.halfDay); att('Absent', ao.absent); att('On leave', ao.onLeave);
  if (ao.offDay) att('Week-off / Holiday', ao.offDay);
  if (ao.noRecord) att('No device data', ao.noRecord);
  if (ao.notYet) att('Not checked in yet', ao.notYet);
  if (ao.upcoming) att('Upcoming day', ao.upcoming);
  att('Of whom late', ao.late, 'Counted inside Present / Half day');
  att('Missing punch', ao.missingPunch, 'Counted inside Present / Half day');
  const lv = (item, v, note) => S.add(`Leave overview - ${p.name}`, item, num(v), note);
  lv('Leave requests', lo.total); lv('Pending approvals', lo.pending, 'Only leave dated in this range'); lv('Approved', lo.approved); lv('Rejected', lo.rejected); lv('Cancelled', lo.cancelled);
  if (lo.cancellationRequests) lv('Cancellation asked', lo.cancellationRequests);
  lv('Upcoming leaves (from today)', lo.upcoming, 'Approved, starting after today. Not part of the total.');
  const tk = (item, v, note) => S.add('Pending tasks and approvals (now)', item, num(v), note);
  tk('Leave approvals', pt.leaveApprovals, pt.leaveApprovalsFromLeft ? `${pt.leaveApprovalsFromLeft} are from people who have left` : 'Every pending request, any dates');
  tk('Attendance regularization', pt.attendanceRegularization); tk('Late coming requests waiting', pt.lateComing); tk('Assets assigned', pt.assetsAssigned); tk('Training pending', pt.trainingPending); tk('Open targets', pt.openTargets); tk('Open tickets', pt.openTickets);

  const sheets = [S.sheet()];

  // Chart numbers, long form: Chart · Group · Series · Value.
  const chartRows = [];
  arr(d.charts).forEach((c) => {
    arr(c.rows).forEach((r) => {
      if (c.kind === 'bar') chartRows.push([c.title, r.label, c.unit || 'Value', num(r.value)]);
      else arr(c.series).forEach((s, i) => chartRows.push([c.title, r.label, s, num((r.values || [])[i])]));
    });
  });
  if (chartRows.length) sheets.push({ name: 'Charts', headers: ['Chart', 'Group', 'Series', 'Value'], rows: chartRows });

  sheets.push({
    name: 'Headcount by department',
    headers: ['Department', 'Working now', 'Left', 'Total'],
    rows: arr(d.headcountByDepartment).map((r) => [r.department, num(r.working), num(r.left), num(r.total)]),
  });
  if (arr(d.celebrations).length) {
    sheets.push({
      name: 'Birthdays and anniversaries',
      headers: ['Name', 'What', 'On', 'In days', 'Years with us'],
      rows: d.celebrations.map((c) => [c.name, c.kind, dayOf(c.on || c.date), num(c.inDays), c.years == null ? '' : num(c.years)]),
    });
  }
  lists.forEach((l) => { if (l.rows.length) sheets.push({ name: l.name, headers: l.columns.map((c) => c.label), rows: l.rows.slice(0, LIST_CAP).map((r) => l.columns.map((c) => (r[c.key] === undefined || r[c.key] === null ? '' : r[c.key]))) }); });

  const frows = [['Date range', `${p.name} (${p.from} to ${p.to})`]];
  Object.keys(FILTER_NAMES).forEach((k) => {
    if (query[k]) frows.push([FILTER_NAMES[k], k === 'manager' ? (managerName || query[k]) : query[k]]);
  });
  if (frows.length === 1) frows.push(['Other filters', 'None - everyone in your area']);
  sheets.push({ name: 'Filters used', headers: ['Filter', 'Value'], rows: frows });
  return { sheets };
}

// ===========================================================================
// ACCOUNTS
// ===========================================================================
function accountsBook(d) {
  const S = summaryBuilder();
  const s = d.summary; const r = (n) => (n === null || n === undefined ? '' : Number(n));
  const per = d.period && !d.period.all ? `${d.period.from} to ${d.period.to}` : 'All time';
  S.add('About', 'Dashboard', 'Accounts Dashboard');
  S.add('About', 'Period', per);
  S.add('About', 'Numbers as of', d.today, 'All amounts in rupees');
  S.add('Money', 'Invoices (count)', r(s.total.invoices));
  S.add('Money', 'Total before GST', r(s.total.billing));
  S.add('Money', 'GST charged', r(s.total.gst));
  S.add('Money', 'Total after GST', r(s.total.invoiceValue));
  S.add('Money', 'TDS', r(s.total.tds));
  S.add('Money', 'Receivable (after credit / debit notes)', r(s.total.receivable));
  S.add('Money', 'Received', r(s.received.amount), `${s.received.receipts} receipt(s) on ${s.received.invoices} invoice(s) - ${s.received.collectedPct}% collected`);
  S.add('Money', 'Pending', r(s.pending.amount), `${s.pending.count} invoice(s) from ${s.pending.clients} client(s)${s.pending.nextDue ? ` - next due ${s.pending.nextDue}` : ''}`);
  S.add('Money', 'Overdue', r(s.overdue.amount), `${s.overdue.count} invoice(s)`);
  arr(s.overdue.buckets).forEach((bk) => S.add('Overdue by age', bk.bucket, r(bk.amount), `${bk.count} invoice(s)`));
  S.add('Office spends', 'Total (paid + to pay)', r(s.expenses.total), `${s.expenses.count} bill(s)`);
  S.add('Office spends', 'Paid', r(s.expenses.paid));
  S.add('Office spends', 'To pay', r(s.expenses.pending));
  S.add('Office spends', 'Overdue to pay', r(s.expenses.overdue));
  S.add('Office spends', 'Bills with proof missing', r(s.expenses.missingProof));
  S.add('Profit', 'Income before GST', r(s.profit.income));
  S.add('Profit', 'TDS', r(s.profit.tds));
  S.add('Profit', 'Office costs before GST', r(s.profit.expensesBeforeGst));
  S.add('Profit', 'Profit after expenses', r(s.profit.amount), 'GST is never counted as income or cost');
  const g = d.gst;
  S.add('GST position', 'GST charged to clients', r(g.charged));
  S.add('GST position', 'GST collected', r(g.collected));
  S.add('GST position', 'GST still to collect', r(g.pendingFromClients));
  S.add('GST position', 'GST paid to vendors', r(g.paidToVendors));
  S.add('GST position', 'Input credit - eligible', r(g.itc.eligible), `${g.itc.eligibleBills} bill(s)`);
  S.add('GST position', 'Input credit - waiting for a vendor tax invoice', r(g.itc.missingProof), `${g.itc.missingProofBills} bill(s)`);
  S.add('GST position', 'Input credit - not claimable (no GSTIN)', r(g.itc.notClaimable), `${g.itc.notClaimableBills} bill(s)`);
  S.add('GST position', 'GST payable (estimate)', r(g.payable));
  S.add('Proof', 'Records with proof missing', r(d.proof.counts.missing), `Amount ${d.proof.counts.amount}`);
  const sheets = [S.sheet()];

  sheets.push({
    name: 'Clients',
    headers: ['Client', 'Department', 'Account manager', 'Invoices', 'Before GST', 'After GST', 'Receivable', 'Received', 'Pending', 'Overdue', 'Collected %', 'Last payment', 'Next due', 'Days overdue', 'Proof', 'Status'],
    rows: arr(d.clients).map((c) => [c.client, c.department, c.manager || '', r(c.invoiceCount), r(c.billing), r(c.invoiceValue), r(c.receivable), r(c.received), r(c.pending), r(c.overdue), r(c.collectedPct), dayOf(c.lastPayment), dayOf(c.nextDue), r(c.daysOverdue), c.proofStatus, c.status]),
  });
  sheets.push({
    name: 'Invoices',
    headers: ['Invoice', 'Date', 'Due', 'Client', 'Candidate', 'Requirement', 'Employee', 'Account manager', 'Department', 'Before GST', 'GST', 'After GST', 'TDS', 'Receivable', 'Received', 'Pending', 'Status', 'Days overdue', 'Last payment', 'Proof'],
    rows: arr(d.clients).flatMap((c) => arr(c.invoices)).map((i) => [i.invoiceNumber || '', dayOf(i.invoiceDate), dayOf(i.dueDate), i.client, i.candidateName || '', i.role || '', i.employee || '', i.accountManager || '', i.department || '', r(i.billing), r(i.gst), r(i.invoiceValue), r(i.tds), r(i.receivable), r(i.received), r(i.pending), i.status, r(i.daysOverdue), dayOf(i.lastPayment), i.proof || '']),
  });
  const od = arr(s.overdue.rows);
  if (od.length) {
    sheets.push({
      name: 'Overdue invoices',
      headers: ['Invoice', 'Client', 'Invoice date', 'Due', 'Amount', 'Received', 'Pending', 'Days overdue', 'Age', 'Assigned to', 'Last payment'],
      rows: od.map((o) => [o.invoiceNumber || '', o.client, dayOf(o.invoiceDate), dayOf(o.dueDate), r(o.amount), r(o.received), r(o.pending), r(o.daysOverdue), o.bucket, o.assigned || '', dayOf(o.lastPayment)]),
    });
  }
  const rows = arr(d.office.rows);
  if (rows.length) {
    sheets.push({
      name: 'Office bills',
      headers: ['Code', 'Date', 'Due', 'Category', 'Vendor', 'Bill no', 'Before GST', 'GST', 'TDS', 'After GST', 'Net to pay', 'Paid', 'To pay', 'Status', 'Days overdue', 'Proof', 'GSTIN', 'Added by'],
      rows: rows.map((e) => [e.code || '', dayOf(e.date), dayOf(e.dueDate), e.category, e.vendor || '', e.billNumber || '', r(e.base), r(e.gst), r(e.tds), r(e.afterGst), r(e.net), r(e.paid), r(e.pending), e.payStatus, r(e.daysOverdue), e.proofStatus, e.gstin || '', e.employee || '']),
    });
  }
  if (arr(g.pendingRows).length) {
    sheets.push({
      name: 'GST still to collect',
      headers: ['Invoice', 'Client', 'Due', 'GST charged', 'GST still to collect', 'Days overdue'],
      rows: g.pendingRows.map((x) => [x.invoiceNumber || '', x.client, dayOf(x.dueDate), r(x.gst), r(x.pending), r(x.daysOverdue)]),
    });
  }
  if (arr(d.proof.records).length) {
    sheets.push({
      name: 'Proof missing',
      headers: ['Type', 'Party', 'Reference', 'Amount', 'Paid on', 'Proof needed', 'Status', 'Accountant', 'Reminders sent'],
      rows: d.proof.records.map((x) => [x.kind === 'invoice' ? 'Client receipt' : 'Office bill', x.party || '', x.ref || '', r(x.amount), dayOf(x.paidOn), x.proofType || '', x.status, x.accountant || '', r(x.reminders)]),
    });
  }
  const f = d.filters || {};
  const frows = [['Period', per]];
  [['client', 'Client'], ['dept', 'Department'], ['section', 'Section'], ['role', 'Role'], ['emp', 'Employee'], ['q', 'Search']].forEach(([k, label]) => {
    if (!f[k]) return;
    const o = arr((d.facets || {})[k]).find((x) => x.value === f[k]);
    frows.push([label, o ? o.label : f[k]]);
  });
  if (frows.length === 1) frows.push(['Other filters', 'None - everything']);
  frows.push(['Invoices shown', `${d.counts.invoicesShown} of ${d.counts.invoicesEver}`]);
  frows.push(['Office bills shown', d.counts.expensesShown]);
  sheets.push({ name: 'Filters used', headers: ['Filter', 'Value'], rows: frows });
  return { sheets };
}

module.exports = { atsHomeBook, hrmsBook, accountsBook, LIST_CAP };
