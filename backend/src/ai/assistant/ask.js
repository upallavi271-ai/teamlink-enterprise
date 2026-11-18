// ---------------------------------------------------------------------------
// ASK MODE - the AI ASSISTANT (spec 8). It READS, COUNTS, COMPARES and
// RECOMMENDS. It never changes anything:
//
//   * this file imports no write path: only makeReader().get (GET requests as
//     the logged-in user), the existing read tools (utils/aiAgentTools.js, which
//     check can() + scope), and read-only Prisma counts through lib/entities.js;
//   * a request that is really an ACTION ("move Rahul to interview") is not
//     done - the answer says so and points to Do mode;
//   * every answer carries its numbers and where they came from:
//     "Counted from Attendance, 2026-09-29, your area: All Company".
//
// tryAnswer() returns null when the question is not one it can answer from the
// app's data; routes/assistant.js then hands it to the language model (facts
// block) exactly as before. With no model, the caller says so in plain words.
// ---------------------------------------------------------------------------

const { makeReader } = require('../lib/http');
const { parseWhen, translateDateWords, niceDate, ymd, addDays } = require('../lib/dates');
const entities = require('../lib/entities');
const engine = require('../intent/engine');
const registry = require('../registry');
const perm = require('../permissions');
const { runTool } = require('../../utils/aiAgentTools');
const { scopeLabel } = require('../../utils/scope');
const { can } = require('../../utils/permissions');
const { stageLabel } = require('../../utils/atsVocab');

const num = (n) => Number(n || 0).toLocaleString('en-IN');
const rupees = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// --- Telugu / Hindi question words -> English ------------------------------------------------
function normalise(text) {
  let t = ` ${String(text || '').toLowerCase()} `;
  t = translateDateWords(t);
  t = t.replace(/\b(?:entha|enta|ettani|kitne)\s*(?:mandi|log|logon)?\b/g, ' how many ')
    .replace(/\b(?:evaru|evvaru|kaun)\b/g, ' who ')
    .replace(/\bnaa\b|\bnaku\b|\bnaaku\b|\bmera\b|\bmeri\b/g, ' my ')
    .replace(/\bselavu\b|\bchhutti\b/g, ' leave ')
    .replace(/\bleave lo\b|\bselavu lo\b/g, ' on leave ')
    .replace(/\bgeru\b|\bhaajar\b/g, ' absent ')
    .replace(/\s+/g, ' ');
  return t;
}

// --- "today", "this week", "last month", "on 12 Oct" -> a period -------------------------------------
function periodOf(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  const day = (d) => ymd(d);
  const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));
  if (/\blast week\b/.test(t)) { const m = monday(addDays(now, -7)); return { from: day(m), to: day(addDays(m, 6)), label: 'last week', kind: 'range' }; }
  if (/\bthis week\b|\bthis wk\b/.test(t)) { const m = monday(now); return { from: day(m), to: day(addDays(m, 6)), label: 'this week', kind: 'range' }; }
  if (/\blast month\b/.test(t)) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: day(first), to: day(last), label: `${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}`, kind: 'range', month: day(first).slice(0, 7) };
  }
  if (/\bthis month\b/.test(t)) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: day(first), to: day(last), label: `${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}`, kind: 'range', month: day(first).slice(0, 7) };
  }
  const w = parseWhen(t, { now, dir: 'past' });
  if (w.dates.length >= 2) return { from: w.dates[0], to: w.dates[w.dates.length - 1], label: `${niceDate(w.dates[0])} to ${niceDate(w.dates[w.dates.length - 1])}`, kind: 'range' };
  if (w.dates.length === 1) return { from: w.dates[0], to: w.dates[0], label: w.dates[0] === day(now) ? 'today' : `on ${niceDate(w.dates[0])}`, kind: 'day' };
  return { from: day(now), to: day(now), label: 'today', kind: 'day', defaulted: true };
}

// --- Answer shapes ----------------------------------------------------------------------------------------------
const answer = (text, { numbers = [], source = '', rows = null, options = [], area = null } = {}) => ({
  handled: true, mode: 'ask', answer: text, numbers, source, rows, options, area,
});

function scopeText(user, product) {
  try { return scopeLabel(user, product); } catch { return 'your access'; }
}

const denied = (what) => answer(`${what} Nothing was read.`, { source: 'Checked against your role in Role Catalog.' });
const own = (user) => !!(user && user.employeeId);

// ----------------------------------------------------------------------------------------------------------------
// The handlers. `test(t, ctx)` decides; `run(ctx)` answers. Order matters: personal ones first.
// ----------------------------------------------------------------------------------------------------------------
const HANDLERS = [];
const add = (h) => HANDLERS.push(h);

const isQ = (t) => /\b(how many|how much|who|which|what|show|list|count|total|number of|is there|are there|any|tell me|give me|compare|trend|status|summary|summar|report|recommend)\b|\?/.test(t);
const mine = (t) => /\b(my|mine|i have|i am|i was|am i|do i|can i)\b/.test(t);
const someoneElse = (t, ctx) => (ctx.names || []).length > 0 && !mine(t);

// --- my leave / attendance / payslip / timesheet (an employee's own, via the existing read tools) -------------------------------
add({
  id: 'my_leave', self: true, product: 'hrms',
  test: (t) => (mine(t) && /\bleave|\bleaves\b/.test(t)) || /leave (balance|left|remaining)|how much (casual |sick |earned )?leave/.test(t),
  async run(ctx) {
    const r = await runTool(ctx.user, 'my_leave', {});
    if (r.denied || r.notApplicable) return denied(r.denied ? 'Your role cannot read leave records.' : 'Your login has no employee record, so there is no personal leave to read.');
    if (r.error) return null;
    const bal = r.balances || [];
    const text = bal.length
      ? `Your leave balance: ${bal.map((b) => `${b.type} ${b.remaining} of ${b.entitlement}`).join(', ')}. ${r.pendingCount ? `${r.pendingCount} request(s) are waiting for a decision.` : 'Nothing is waiting for a decision.'}`
      : 'There is no leave balance on your record yet.';
    return answer(text, {
      numbers: bal.map((b) => ({ label: `${b.type} left`, value: b.remaining })).concat([{ label: 'Waiting for a decision', value: r.pendingCount || 0 }]),
      source: 'Read from your Leave balance ledger (Leave & Holidays). Only your own record.', area: 'hrms',
    });
  },
});
add({
  id: 'my_attendance', self: true, product: 'hrms',
  test: (t) => mine(t) && /(attendance|late|present|absent|punch|check.?in)/.test(t),
  async run(ctx) {
    const month = ctx.period.month || ctx.today.slice(0, 7);
    const r = await runTool(ctx.user, 'my_attendance', { month });
    if (r.denied || r.notApplicable) return denied(r.denied ? 'Your role cannot read attendance.' : 'Your login has no employee record, so there is no personal attendance to read.');
    if (r.error) return null;
    const c = r.byStatus || {};
    const parts = Object.entries(c).map(([k, v]) => `${v} ${k.toLowerCase()}`);
    return answer(r.markedDays ? `In ${month} you have ${r.markedDays} marked day(s): ${parts.join(', ')}.` : `No attendance is marked for you in ${month} yet.`, {
      numbers: Object.entries(c).map(([k, v]) => ({ label: k, value: v })).concat([{ label: 'Days marked', value: r.markedDays }]),
      source: `Counted from your own Attendance records for ${month}.`, area: 'hrms',
    });
  },
});
add({
  id: 'my_payslip', self: true, product: 'hrms',
  test: (t, ctx) => mine(t) && /(payslip|pay slip|net pay|salary|take.?home)/.test(t) && !ctx.names.length,
  async run(ctx) {
    const r = await runTool(ctx.user, 'my_payslips', { months: 3 });
    if (r.denied || r.notApplicable) return denied(r.denied ? 'Your role cannot read payslips.' : 'Your login has no employee record, so there is no payslip to read.');
    if (r.error) return null;
    const list = r.payslips || r.rows || r.months || [];
    if (!list.length) return answer('There is no payslip on your record yet.', { source: 'Read from your own Payroll records.', area: 'hrms' });
    const top = list[0];
    return answer(`Your latest payslip (${top.month}): net pay ${rupees(top.netPay != null ? top.netPay : top.net)}.`, {
      numbers: list.slice(0, 3).map((p) => ({ label: p.month, value: rupees(p.netPay != null ? p.netPay : p.net) })),
      source: 'Read from your own Payroll records. Only your own payslips.', area: 'hrms',
    });
  },
});
add({
  id: 'my_tasks', self: true, product: 'hrms',
  test: (t) => mine(t) && /(task|timesheet|to.?do)/.test(t),
  async run(ctx) {
    const r = await runTool(ctx.user, 'my_tasks', {});
    if (r.denied || r.notApplicable) return denied('Your role cannot read tasks.');
    if (r.error) return null;
    const tasks = r.tasks || r.rows || [];
    return answer(tasks.length ? `You have ${tasks.length} open task(s): ${tasks.slice(0, 5).map((x) => x.name || x.title).join('; ')}.` : 'You have no open tasks.', {
      numbers: [{ label: 'Open tasks', value: tasks.length }], source: 'Read from your own Tasks / timesheet.', area: 'hrms',
    });
  },
});

// --- pay of OTHER people is never read out ------------------------------------------------------------------------------------------------------
add({
  id: 'salary_other', product: 'hrms',
  test: (t, ctx) => /(salary|ctc|payslip|pay slip|net pay|increment)/.test(t) && ctx.names.length > 0 && !mine(t),
  async run(ctx) {
    const may = await can(ctx.user, 'hrms', 'hrms', 'Payroll & Compensation', 'view');
    const op = await can(ctx.user, 'hrms', 'hrms', 'Payroll & Compensation', 'edit');
    if (!may || !op) return denied('Your role cannot see other people\'s salary or payslips.');
    return answer('I do not read out other people\'s pay in chat. Open Payroll -> Payroll & Compensation to see it there.', { source: 'Pay is shown only on the Payroll screen.', area: 'hrms' });
  },
});

// --- who is on leave / pending leave ---------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'pending_leave', product: 'hrms',
  test: (t) => /(pending|waiting|awaiting).*(leave|approval|decision)|approvals? (waiting|pending)|what.*waiting for (me|my)/.test(t),
  async run(ctx) {
    const r = await runTool(ctx.user, 'hr_pending_approvals', {});
    if (r.denied) return denied('Your role cannot see the approvals queue.');
    if (r.error) return null;
    const t = r.totals || {};
    return answer(`Waiting for a decision: ${t.leave || 0} leave request(s), ${t.profiles || 0} profile(s) to review, ${t.editAccess || 0} edit-access request(s).`, {
      numbers: [{ label: 'Leave requests', value: t.leave || 0 }, { label: 'Profiles to review', value: t.profiles || 0 }, { label: 'Edit-access requests', value: t.editAccess || 0 }],
      source: `Counted from Leave & Holidays and Employee profiles. Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
    });
  },
});
add({
  id: 'on_leave', product: 'hrms',
  test: (t) => /(on leave|who.*(leave|off)|leave (today|tomorrow|this week)|is anyone off|anyone on leave|how many.*(leave|off))/.test(t) && !mine(t),
  async run(ctx) {
    const p = ctx.period;
    const r = await runTool(ctx.user, 'who_is_on_leave', { from: p.from, to: p.to });
    if (r.denied) return denied('Your role cannot see other people\'s leave.');
    if (r.error) return null;
    const reqs = r.requests || [];
    const names = [...new Set(reqs.map((x) => x.name))];
    const text = reqs.length
      ? `${names.length} ${names.length === 1 ? 'person is' : 'people are'} on leave ${p.label}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ' and more' : ''}.`
      : `Nobody is on leave ${p.label} (in the part of the company you can see).`;
    return answer(text, {
      numbers: [{ label: 'People on leave', value: names.length }, { label: 'Requests', value: reqs.length }],
      rows: reqs.slice(0, 12).map((x) => [x.name, x.type, `${x.fromDate}${x.toDate !== x.fromDate ? ` to ${x.toDate}` : ''}`, x.status]),
      source: `Read from Leave & Holidays requests overlapping ${p.from === p.to ? p.from : `${p.from} to ${p.to}`}. Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
    });
  },
});

// --- attendance of the company (absent / present / late today, this week) ------------------------------------------------------------------------
add({
  id: 'attendance_org', product: 'hrms',
  test: (t, ctx) => /(absent|present|late|attendance|not checked|check.?in|punch|half day)/.test(t) && isQ(t) && !mine(t) && !(ctx.names.length && /\b(of|for)\b/.test(t) && false),
  async run(ctx) {
    const p = ctx.period;
    const t = ctx.t;
    const focus = /absent|not (come|came|here)/.test(t) ? 'absent' : /\blate\b/.test(t) ? 'late' : /half day/.test(t) ? 'halfDay' : /present|in office|attended/.test(t) ? 'present' : 'absent';
    const reader = ctx.reader;
    if (p.kind === 'range' && p.from !== p.to) {
      const r = await reader.get(`/attendance/dashboard?from=${p.from}&to=${p.to}`);
      if (r.status === 403) return denied('Your role cannot see everyone\'s attendance (it needs the Attendance & Time reports). Ask "my attendance" to see your own.');
      if (!r.ok) return null;
      const s = r.data.summary || {};
      const pd = s.personDays || {};
      return answer(`${p.label[0].toUpperCase()}${p.label.slice(1)} (${p.from} to ${p.to}): ${num(pd.present)} present-days, ${num(pd.absent)} absent-days, ${num(pd.late)} late-days and ${num(pd.onLeave)} leave-days across ${num(s.people)} people. ${num(s.absentAny)} different people were absent at least once.`, {
        numbers: [{ label: 'People', value: s.people }, { label: 'Absent at least once', value: s.absentAny }, { label: 'Absent-days', value: pd.absent }, { label: 'Late-days', value: pd.late }, { label: 'Leave-days', value: pd.onLeave }],
        source: `Counted from Attendance (daily attendance rules: Absent = no check-in and no leave or request), ${p.from} to ${p.to}. Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
      });
    }
    const r = await reader.get(`/attendance/dashboard?date=${p.from}`);
    if (r.status === 403) return denied('Your role cannot see everyone\'s attendance (it needs the Attendance & Time reports). Ask "my attendance" to see your own.');
    if (!r.ok) return null;
    const k = r.data.kpis || {};
    const latest = r.data.latestDataDate;
    const base = {
      // THE TILE SET: Present + Absent + Half day + On leave + Week off / Holiday = Headcount.
      // Late / Early logout / Missing check-in / Missing check-out are notes INSIDE Present.
      numbers: [{ label: 'On the rolls', value: k.headcount }, { label: 'Present', value: k.present }, { label: 'Absent', value: k.absent }, { label: 'Half day', value: k.halfDay }, { label: 'On leave', value: k.onLeave }, { label: 'Week off / Holiday', value: k.offDay }, ...(k.notYet ? [{ label: 'Not checked in yet', value: k.notYet }] : []), { label: 'Of the present: late', value: k.late }, ...(k.lateExcused ? [{ label: 'Late, excused by permission', value: k.lateExcused }] : [])],
      source: `Counted from Attendance (Present includes people who were late, left early or missed a check-in / check-out; Absent = no check-in and no leave or request) for ${p.from}. Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
    };
    if (latest && p.from > latest && !k.present && !k.absent && !k.late) {
      return answer(`No attendance has been recorded for ${niceDate(p.from)} yet - the latest day with attendance data is ${niceDate(latest)}. ${num(k.notYet || k.headcount)} people are on the rolls.`, base);
    }
    const label = { absent: 'absent', late: 'present but came late', halfDay: 'on a half day', present: 'present' }[focus];
    const count = k[focus] != null ? k[focus] : 0;
    const names = (r.data.marking || []).filter((m) => (focus === 'late' ? (m.bucket === 'present' && m.late) : m.bucket === focus)).map((m) => m.name);
    const wantNames = /\b(who|list|names|show)\b/.test(t);
    let text = `${num(count)} of ${num(k.headcount)} ${k.headcount === 1 ? 'employee is' : 'employees are'} ${label} ${p.label}.`;
    // The whole picture in the one equation every screen uses (Late etc. are inside Present).
    text += ` Present ${num(k.present)} + Absent ${num(k.absent)} + Half day ${num(k.halfDay)} + On leave ${num(k.onLeave)} + Week off / Holiday ${num(k.offDay)}${k.notYet ? ` + Not checked in yet ${num(k.notYet)}` : ''}${k.noRecord ? ` + No device data ${num(k.noRecord)}` : ''} = Headcount ${num(k.headcount)}.${k.late ? ` (Of the ${num(k.present)} present, ${num(k.late)} came late.)` : ''}${k.lateExcused ? ` ${num(k.lateExcused)} more came late with an approved late permission, so they are not counted as late.` : ''} On leave counts full-day leave; a half-day leave is counted under Half day (leave and attendance reconcile).`;
    if (wantNames && names.length) text += ` ${names.slice(0, 15).join(', ')}${names.length > 15 ? ` and ${names.length - 15} more` : ''}.`;
    if (p.from === ctx.today && k.notYet) text += ` ${num(k.notYet)} have not checked in yet today, so these numbers can still change.`;
    return answer(text, { ...base, rows: wantNames ? names.slice(0, 15).map((n) => [n]) : null });
  },
});

// --- headcount ---------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'headcount', product: 'hrms',
  test: (t) => /(headcount|how many (employees|people|staff|members)|employees (do we|are there|we have)|by department|department wise|notice period|attrition|people (do we|are there))/.test(t),
  async run(ctx) {
    const r = await runTool(ctx.user, 'headcount_summary', {});
    if (r.denied) return denied('Your role cannot see the headcount.');
    if (r.error) return null;
    const st = Object.fromEntries((r.byStatus || []).map((x) => [x.name, x.count]));
    const working = (st.Active || 0) + (st['Notice Period'] || 0);
    const depts = (r.byDepartment || []).filter((d) => !/zztest|^\(none\)$/i.test(d.name));
    const text = `${num(working)} people are working now (${num(st.Active || 0)} active, ${num(st['Notice Period'] || 0)} on notice). ${num(r.total)} records are on file in total, including ${num((st.Relieved || 0) + (st.Exited || 0))} who have left.`;
    return answer(text, {
      numbers: [{ label: 'Working now', value: working }, { label: 'Active', value: st.Active || 0 }, { label: 'Notice period', value: st['Notice Period'] || 0 }, { label: 'Left (relieved / exited)', value: (st.Relieved || 0) + (st.Exited || 0) }],
      rows: depts.slice(0, 10).map((d) => [d.name, d.count]),
      source: `Counted from Employee records (all statuses). Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
    });
  },
});

// --- pipeline / candidates by step ----------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'pipeline', product: 'ats',
  test: (t) => /(pipeline|candidates? (by|in|at|per)|stage.?wise|step.?wise|how many (candidates?|applicants?|applications?|profiles?)|candidates? (are|is) (in|at))/.test(t),
  async run(ctx) {
    if (!await can(ctx.user, 'ats', 'candidates', 'Applications', 'view')) return denied('Your role cannot see the candidate pipeline.');
    const c = await entities.pipelineCounts(ctx.user);
    const a = ctx.analysis;
    const asked = a.stages.map((s) => s.code);
    const hit = c.rows.filter((r) => asked.includes(r.stage));
    const src = `Counted from Candidates & Pipeline (one count per candidate-on-a-job). Your area: ${scopeText(ctx.user, 'ats')}.`;
    if (hit.length) {
      const n = hit.reduce((x, r) => x + r.count, 0);
      return answer(`${num(n)} candidate${n === 1 ? ' is' : 's are'} at "${hit.map((h) => h.label).join('" / "')}" right now (out of ${num(c.total)} in total).`, {
        numbers: hit.map((h) => ({ label: h.label, value: h.count })).concat([{ label: 'All candidates', value: c.total }]), source: src, area: 'ats',
      });
    }
    const top = c.rows.slice(0, 8);
    return answer(`${num(c.open)} candidates are still moving through the process (out of ${num(c.total)} in total). Most are at "${top[0] ? top[0].label : '-'}"${top[1] ? `, then "${top[1].label}"` : ''}.`, {
      numbers: [{ label: 'Still moving', value: c.open }, { label: 'All', value: c.total }],
      rows: top.map((r) => [r.label, r.count]), source: src, area: 'ats',
    });
  },
});

// --- jobs / requirements -----------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'jobs', product: 'ats',
  test: (t) => /(job|jobs|requirement|requirements|opening|openings|vacanc)/.test(t) && /(how many|status|open|late|without|unassigned|need|count|summary|total|which)/.test(t) && !/interview|candidate/.test(t),
  async run(ctx) {
    const r = await ctx.reader.get('/requirements/summary');
    if (r.status === 403) return denied('Your role cannot see the requirements summary.');
    if (!r.ok) return null;
    const c = r.data.cards || {};
    const chain = (r.data.chain || []).map((x) => [x.label, x.count]);
    return answer(`${num(c.open)} requirements are open out of ${num(r.data.total)}. ${num(c.needsRecruiter)} still need a recruiter, ${num(c.needsTl)} need a team lead, ${num(c.late)} are late, ${c.waitingAgreement === null || c.waitingAgreement === undefined ? '' : `${num(c.waitingAgreement)} are waiting for the client agreement, `}and ${num(c.hold)} are on hold.`, {
      numbers: [{ label: 'Open', value: c.open }, { label: 'Need a recruiter', value: c.needsRecruiter }, { label: 'Need a team lead', value: c.needsTl }, { label: 'Late', value: c.late }, ...(c.waitingAgreement === null || c.waitingAgreement === undefined ? [] : [{ label: 'Waiting for agreement', value: c.waitingAgreement }]), { label: 'On hold', value: c.hold }],
      rows: chain, source: `Counted from Requirements. Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'ats',
    });
  },
});

// --- joinings --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'joinings', product: 'ats',
  test: (t) => /(who|how many).*(joined|joining)|joinings?\b|offers? (open|pending|out)|waiting to join/.test(t) && !/interview/.test(t),
  async run(ctx) {
    const open = /offer/.test(ctx.t);
    const r = await runTool(ctx.user, 'recent_joinings', open ? { openOffersOnly: true } : {});
    if (r.denied) return denied('Your role cannot see joinings.');
    if (r.error) return null;
    const rows = r.rows || [];
    const joined = rows.filter((x) => /joined|hired/i.test(x.stage));
    const p = ctx.period;
    const inPeriod = joined.filter((x) => (x.joinedAt || x.joiningDate || '').slice(0, 10) >= p.from && (x.joinedAt || x.joiningDate || '').slice(0, 10) <= p.to);
    if (open) {
      return answer(`${num(rows.length)} offer(s) are still open (not yet accepted or declined).`, {
        numbers: [{ label: 'Open offers', value: rows.length }], rows: rows.slice(0, 10).map((x) => [x.candidate, x.requirement, x.client, x.offerStatus || x.stage]),
        source: `Read from Offers & Joining. Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'ats',
      });
    }
    return answer(`${num(joined.length)} candidate(s) show as Joined in the part of the pipeline you can see${p.defaulted ? '' : `; ${num(inPeriod.length)} of them joined ${p.label}`}.`, {
      numbers: [{ label: 'Joined (all time shown)', value: joined.length }, ...(p.defaulted ? [] : [{ label: `Joined ${p.label}`, value: inPeriod.length }])],
      rows: joined.slice(0, 10).map((x) => [x.candidate, x.requirement, x.client, (x.joinedAt || x.joiningDate || '').slice(0, 10)]),
      source: `Read from Offers & Joining (latest ${rows.length} records). Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'ats',
    });
  },
});

// --- interviews --------------------------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'interviews', product: 'ats',
  test: (t) => /interview/.test(t) && /(who|how many|which|list|upcoming|today|tomorrow|this week|coming|scheduled|booked|show)/.test(t) && !/(schedule|book|arrange|reschedule|postpone|fix)\b.*\b(for|with)\b/.test(t),
  async run(ctx) {
    const p = ctx.period;
    const days = Math.max(1, Math.min(90, Math.ceil((new Date(`${p.to}T23:59:59`) - new Date()) / 86400000) + 1));
    const r = await runTool(ctx.user, 'upcoming_interviews', { days: Math.max(days, 1) });
    if (r.denied) return denied('Your role cannot see interviews.');
    if (r.error) return null;
    const inside = (r.interviews || []).filter((x) => String(x.at).slice(0, 10) >= p.from && String(x.at).slice(0, 10) <= p.to);
    return answer(inside.length ? `${num(inside.length)} interview(s) ${p.label}: ${inside.slice(0, 6).map((x) => `${x.candidate} (${String(x.at).slice(11, 16)})`).join(', ')}${inside.length > 6 ? ' and more' : ''}.` : `No interviews are booked ${p.label} (in the part of the pipeline you can see).`, {
      numbers: [{ label: `Interviews ${p.label}`, value: inside.length }],
      rows: inside.slice(0, 10).map((x) => [x.candidate, x.requirement, x.client, String(x.at).replace('T', ' ').slice(0, 16)]),
      source: `Read from the Interview Calendar, ${p.from === p.to ? p.from : `${p.from} to ${p.to}`}. Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'ats',
    });
  },
});

// --- invoices / money --------------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'invoices', product: 'accounts',
  test: (t) => /(outstanding|overdue|receivable|invoiced|collection|unpaid|invoices?|received|due)/.test(t) && isQ(t) && !/expense/.test(t),
  async run(ctx) {
    if (/\b(which|list|show)\b.*\binvoices?\b|overdue invoices/.test(ctx.t) && /overdue|unpaid|pending/.test(ctx.t)) {
      const r = await runTool(ctx.user, 'search_invoices', { status: /overdue/.test(ctx.t) ? 'Overdue' : 'Pending' });
      if (r.denied) return denied('Your role cannot see invoices.');
      const inv = r.invoices || [];
      return answer(inv.length ? `${inv.length} invoice(s): ${inv.slice(0, 5).map((i) => `${i.invoiceNumber || i.number} ${i.client} ${rupees(i.outstanding)}`).join('; ')}.` : 'No invoices match.', {
        numbers: [{ label: 'Invoices', value: inv.length }], rows: inv.slice(0, 10).map((i) => [i.invoiceNumber || i.number, i.client, rupees(i.outstanding), i.status]),
        source: `Read from Invoices. Your area: ${scopeText(ctx.user, 'accounts')}.`, area: 'accounts',
      });
    }
    const r = await runTool(ctx.user, 'accounts_summary', {});
    if (r.denied) return denied('Your role cannot see invoices and receivables.');
    if (r.error) return null;
    return answer(`${rupees(r.outstanding)} is outstanding, of which ${rupees(r.overdue)} is overdue. So far ${rupees(r.invoiced)} has been invoiced and ${rupees(r.received)} received across ${num(r.invoiceCount)} invoices.`, {
      numbers: [{ label: 'Invoiced', value: rupees(r.invoiced) }, { label: 'Received', value: rupees(r.received) }, { label: 'Outstanding', value: rupees(r.outstanding) }, { label: 'Overdue', value: rupees(r.overdue) }],
      rows: Object.entries(r.ageingOfOutstanding || {}).map(([k, v]) => [k, rupees(v)]),
      source: `Counted from Invoices and Payments (${num(r.invoiceCount)} invoices). Your area: ${scopeText(ctx.user, 'accounts')}.`, area: 'accounts',
    });
  },
});
add({
  id: 'expenses', product: 'accounts',
  test: (t) => /expense|spend|spent/.test(t) && isQ(t),
  async run(ctx) {
    const r = await ctx.reader.get('/office-expenses/summary');
    if (r.status === 403) return denied('Your role cannot see office expenses.');
    if (!r.ok) return null;
    const cats = r.data.byCategory || [];
    const total = cats.reduce((n, c) => n + (c.gross || 0), 0);
    const count = cats.reduce((n, c) => n + (c.count || 0), 0);
    return answer(`Office expenses on record: ${rupees(total)} across ${num(count)} bills. The biggest: ${cats.slice(0, 3).map((c) => `${c.key} ${rupees(c.gross)}`).join(', ')}.`, {
      numbers: [{ label: 'Total expenses', value: rupees(total) }, { label: 'Bills', value: count }],
      rows: cats.slice(0, 8).map((c) => [c.key, c.count, rupees(c.gross)]), source: 'Counted from Office & Expenses (all months on record).', area: 'accounts',
    });
  },
});

// --- comparisons and trends --------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'trend', product: 'ats',
  test: (t) => /(compare|vs\.?|versus|trend|than last|growth|difference|better|worse|up or down)/.test(t),
  async run(ctx) {
    const t = ctx.t;
    const now = new Date(`${ctx.today}T00:00:00`);
    if (/(absent|attendance|late|present)/.test(t)) {
      const mon = addDays(now, -((now.getDay() + 6) % 7));
      const w = (from) => ctx.reader.get(`/attendance/dashboard?from=${ymd(from)}&to=${ymd(addDays(from, 6))}`);
      const [a, b] = await Promise.all([w(mon), w(addDays(mon, -7))]);
      if (a.status === 403) return denied('Your role cannot see everyone\'s attendance.');
      if (!a.ok || !b.ok) return null;
      const pa = a.data.summary.personDays; const pb = b.data.summary.personDays;
      const d = (x, y) => (x - y === 0 ? 'the same' : `${Math.abs(x - y)} ${x > y ? 'more' : 'fewer'}`);
      return answer(`Absent-days: ${pa.absent} this week vs ${pb.absent} last week (${d(pa.absent, pb.absent)}). Late-days: ${pa.late} vs ${pb.late}. Present-days: ${pa.present} vs ${pb.present}. (This week is only counted up to the days that have data.)`, {
        numbers: [{ label: 'Absent-days this week', value: pa.absent }, { label: 'Absent-days last week', value: pb.absent }, { label: 'Late-days this week', value: pa.late }, { label: 'Late-days last week', value: pb.late }],
        source: `Counted from Attendance, week of ${ymd(mon)} vs the week before. Your area: ${scopeText(ctx.user, 'hrms')}.`, area: 'hrms',
      });
    }
    if (/(invoice|outstanding|collect|revenue|received)/.test(t)) {
      const r = await runTool(ctx.user, 'accounts_summary', {});
      if (r.denied) return denied('Your role cannot see invoices and receivables.');
      return answer(`Collected so far: ${rupees(r.received)} of ${rupees(r.invoiced)} invoiced (${r.invoiced ? Math.round((r.received / r.invoiced) * 100) : 0}%). ${rupees(r.overdue)} of the ${rupees(r.outstanding)} outstanding is overdue. I can compare month by month only for joinings and attendance.`, {
        numbers: [{ label: 'Collected %', value: `${r.invoiced ? Math.round((r.received / r.invoiced) * 100) : 0}%` }, { label: 'Overdue', value: rupees(r.overdue) }],
        source: `Counted from Invoices and Payments. Your area: ${scopeText(ctx.user, 'accounts')}.`, area: 'accounts',
      });
    }
    // joinings this month vs last month (recruiter joinings board)
    const m1 = ctx.today.slice(0, 7);
    const m0 = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);
    const [a, b] = await Promise.all([ctx.reader.get(`/recruiter-joinings/board?month=${m1}`), ctx.reader.get(`/recruiter-joinings/board?month=${m0}`)]);
    if (a.status === 403) return denied('Your role cannot see recruiter joinings.');
    if (!a.ok || !b.ok) return null;
    const sum = (x) => (x.data.rows || []).reduce((n, r) => n + (r.joinings || 0), 0);
    const ja = sum(a); const jb = sum(b);
    return answer(`Joinings: ${ja} in ${a.data.label} so far vs ${jb} in ${b.data.label} (${ja === jb ? 'the same' : `${Math.abs(ja - jb)} ${ja > jb ? 'more' : 'fewer'}`}). ${a.data.current ? `${a.data.label} is not over yet.` : ''}`.trim(), {
      numbers: [{ label: a.data.label, value: ja }, { label: b.data.label, value: jb }],
      source: `Counted from Recruiter joinings (Joined step with a joining date in the month). Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'ats',
    });
  },
});

// --- recommended actions ---------------------------------------------------------------------------------------------------------------------------------------------------------------
add({
  id: 'recommend', product: 'ats',
  test: (t) => /(what should i|recommend|suggest|prioriti|do first|next step|what.*(pending|waiting)|summari[sz]e my day|my day|where do i start|todo|to-do)/.test(t),
  async run(ctx) {
    const lines = [];
    const numbers = [];
    const pa = await runTool(ctx.user, 'my_pending_actions', {});
    if (!pa.denied && !pa.error && pa.totalOpen != null) {
      numbers.push({ label: 'Waiting on you (candidates)', value: pa.totalOpen }, { label: 'Late', value: pa.overdue });
      if (pa.overdue) lines.push(`${num(pa.overdue)} candidate follow-up(s) are late - start with those.`);
      const top = Object.entries(pa.byStage || {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
      if (top.length) lines.push(`Most are at "${top[0][0]}" (${top[0][1]})${top[1] ? ` and "${top[1][0]}" (${top[1][1]})` : ''}.`);
      const first = (pa.items || []).find((i) => i.overdue) || (pa.items || [])[0];
      if (first) lines.push(`Do this first: ${first.candidate} - ${first.nextAction || first.stageLabel} (${first.requirement}).`);
    }
    const hr = await runTool(ctx.user, 'hr_pending_approvals', {});
    if (!hr.denied && !hr.error && hr.totals) {
      numbers.push({ label: 'Leave requests waiting', value: hr.totals.leave });
      if (hr.totals.leave) lines.push(`${hr.totals.leave} leave request(s) are waiting for your decision.`);
    }
    const acc = await runTool(ctx.user, 'accounts_summary', {});
    if (!acc.denied && !acc.error && acc.overdue != null) {
      numbers.push({ label: 'Overdue money', value: rupees(acc.overdue) });
      if (acc.overdue > 0) lines.push(`${rupees(acc.overdue)} of invoices is overdue - follow up on collection.`);
    }
    if (!lines.length) return answer('Nothing urgent is waiting on you in the parts of the app you can see.', { numbers, source: 'Checked your pending candidate actions, approvals and receivables.', area: 'home' });
    return answer(`Here is what I would do, in order: ${lines.join(' ')}`, {
      numbers, source: `Counted from your pending actions, approvals and receivables. Your area: ${scopeText(ctx.user, 'ats')}.`, area: 'home',
    });
  },
});

// --- CANDIDATE SEARCH IN PLAIN WORDS (ATS audit 2026-11-18, Q317/Q318) ------------------------------------------------------------------------------------------------------------------------
// "Find 10 MD Cardiologists in Hyderabad", "5+ years java developers bangalore lo kavali": the question becomes filters - how many, the
// qualification (MD, MBBS, B.Tech ...), the city, the minimum experience and the specialization / skill words - and is run over ONLY the
// candidates this login may see (utils/scope.js candidateWhere, the same permission as the Candidates list). Ranked by how much matches.
const prisma = require('../../db');
const { candidateWhere, requirementWhere } = require('../../utils/scope');
const { candidateViewFor } = require('../../utils/aiAgentTools');
const { citiesOf, CITY_ALIASES } = require('../../utils/locationMatch');

// citiesOf() names ANY word (a "find" becomes the city "Find"), so only real cities count: the app's own city list (with its spellings,
// "bangalore" = Bengaluru) plus the other common Indian cities. The location search uses the city's main spellings.
const MORE_CITIES = ['Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Kochi', 'Coimbatore', 'Nagpur', 'Indore', 'Bhopal', 'Chandigarh', 'Mysuru', 'Mysore',
  'Guntur', 'Nellore', 'Tirupati', 'Warangal', 'Kurnool', 'Kakinada', 'Rajahmundry', 'Noida', 'Thane', 'Surat', 'Vadodara', 'Patna', 'Bhubaneswar', 'Madurai',
  'Trichy', 'Mangaluru', 'Mangalore', 'Thiruvananthapuram', 'Trivandrum', 'Goa', 'Nashik', 'Ranchi', 'Raipur', 'Dehradun', 'Kanpur', 'Agra', 'Varanasi', 'Karimnagar', 'Khammam', 'Nizamabad', 'Ongole', 'Anantapur', 'Kadapa', 'Eluru'];
const MORE_CITY_KEYS = new Map(MORE_CITIES.map((c) => [c.toLowerCase(), c]));
function realCity(c) {
  if (!c) return null;
  if (CITY_ALIASES[c.label]) return { key: c.key, label: c.label, spellings: [c.label, ...CITY_ALIASES[c.label].filter((a) => a.length > 3).slice(0, 4)] };
  const more = MORE_CITY_KEYS.get(String(c.key || c.label || '').toLowerCase());
  return more ? { key: more.toLowerCase(), label: more, spellings: [more] } : null;
}

// qualifications: [label, regex over the RAW question (short ones must be written in capitals so "me" / "be" never match)]
const QUALS = [
  ['MBBS', /\bmbbs\b/i], ['MD', /\bMD\b/], ['MS', /\bMS\b/], ['DNB', /\bdnb\b/i], ['DM', /\bDM\b/], ['MCh', /\bm\.?ch\b/i], ['BDS', /\bbds\b/i], ['MDS', /\bmds\b/i],
  ['BAMS', /\bbams\b/i], ['BHMS', /\bbhms\b/i], ['B.Sc Nursing', /\bb\.?\s?sc\.?\s*nursing\b/i], ['GNM', /\bgnm\b/i], ['ANM', /\banm\b/i],
  ['B.Pharm', /\bb\.?\s?pharm/i], ['M.Pharm', /\bm\.?\s?pharm/i], ['Pharm.D', /\bpharm\.?\s?d\b/i], ['B.Tech', /\bb\.?\s?tech\b/i], ['M.Tech', /\bm\.?\s?tech\b/i],
  ['B.E', /\bB\.?E\b/], ['MBA', /\bmba\b/i], ['MCA', /\bmca\b/i], ['BCA', /\bbca\b/i], ['PhD', /\bph\.?\s?d\b/i], ['M.Sc', /\bm\.?\s?sc\b/i], ['B.Sc', /\bb\.?\s?sc\b/i],
  ['B.Com', /\bb\.?\s?com\b/i], ['M.Com', /\bm\.?\s?com\b/i], ['B.Ed', /\bb\.?\s?ed\b/i], ['M.Ed', /\bm\.?\s?ed\b/i], ['NET', /\bNET\b/], ['SET', /\bSET\b/], ['ITI', /\biti\b/i], ['Diploma', /\bdiploma\b/i],
];
const SEARCH_STOP = new Set(('find search show list get give need needs want looking look fetch pull top best good available any some all the a an of for with in at from on to and or who are is me my us please '
  + 'candidates candidate profiles profile people persons person resumes resume cvs cv doctors doctor physicians physician staff '
  + 'years year yrs yr experience exp experienced plus above more than least minimum min atleast fresher freshers '
  + 'kavali kaavali chupinchu vethuku vetuku cheppu ivvu lo ki ni unna vunna undi evaru which what city location based').split(' '));
const stem = (w) => w.replace(/(ologists?|ology)$/, 'olog').replace(/(icians?|ians?)$/, 'ic').replace(/(ists?|ers?|ies|s)$/, (m) => (m === 'ies' ? 'y' : ''));

function parseCandidateSearch(raw) {
  const text = String(raw || '');
  const lower = text.toLowerCase();
  const count = (() => { const m = /\b(\d{1,3})\s+(?!\+?\s*(?:years?|yrs?)\b)[a-z]/i.exec(text); return m ? Math.min(Math.max(Number(m[1]), 1), 25) : 10; })();
  const exp = (() => { const m = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i.exec(text); return m ? Number(m[1]) : null; })();
  const quals = QUALS.filter(([, re]) => re.test(text)).map(([q]) => q);
  const words = lower.replace(/[^a-z0-9.+# ]/g, ' ').split(/\s+/).filter(Boolean);
  const cities = [];
  for (let i = 0; i < words.length; i += 1) {
    for (const span of [words.slice(i, i + 2).join(' '), words[i]]) {
      const c = realCity(citiesOf(span)[0]);
      if (c && !cities.some((x) => x.key === c.key)) { cities.push(c); if (span.includes(' ')) i += 1; break; }
    }
  }
  const cityWords = new Set(cities.flatMap((c) => [c.key, ...c.spellings].map((x) => String(x).toLowerCase())));
  words.forEach((w) => { const c = realCity(citiesOf(w)[0]); if (c && cities.some((x) => x.key === c.key)) cityWords.add(w); });
  const qualWords = new Set(quals.flatMap((q) => q.toLowerCase().replace(/\./g, ' ').split(/\s+/)));
  const kept = words.filter((w) => !SEARCH_STOP.has(w) && !/^\d+\+?$/.test(w) && !cityWords.has(w) && !qualWords.has(w.replace(/\./g, '')) && !QUALS.some(([, re]) => re.test(w.toUpperCase())) && w.length > 1);
  const terms = [...new Set(kept.map(stem).filter((w) => w.length > 1))].slice(0, 6);
  return { count, exp, quals, cities, terms, shown: [...new Set(kept)].slice(0, 6) }; // shown: the words as typed, for the answer
}

add({
  id: 'candidate-search', product: 'ats',
  test: (t) => !/\bhow many\b/.test(t) && /\b(find|search|show|list|get|need|want|looking for|fetch|give|kavali|kaavali|chupinchu|vethuku|vetuku)\b/.test(t)
    && /\b(candidates?|profiles?|doctors?|nurses?|engineers?|developers?|teachers?|faculty|professors?|lecturers?|physicians?|consultants?|technicians?|executives?|resumes?|ologists?|pharmacists?|accountants?|supervisors?|operators?)\b/.test(t),
  async run(ctx) {
    if (!await can(ctx.user, 'ats', 'candidates', 'Candidate List', 'view')) {
      return answer('You do not have access to the Candidates list, so I cannot search candidates for you.', { source: 'Checked against your role.' });
    }
    const view = await candidateViewFor(ctx.user);
    const q = parseCandidateSearch(ctx.text);
    const or = [];
    const fields = ['specialization', 'skills', 'education', 'currentDesignation', 'technicalSkills'];
    q.terms.forEach((w) => fields.forEach((f) => or.push({ [f]: { contains: w } })));
    q.quals.forEach((ql) => ['education', 'specialization'].forEach((f) => or.push({ [f]: { contains: ql.replace(/\./g, '') } }, { [f]: { contains: ql } })));
    const and = [];
    if (or.length) and.push({ OR: or });
    if (q.exp != null) and.push({ experienceYears: { gte: q.exp } });
    if (q.cities.length && !view.bde) and.push({ OR: q.cities.flatMap((c) => c.spellings.flatMap((sp) => [{ location: { contains: sp } }, { preferredLocation: { contains: sp } }])) });
    const where = { AND: [candidateWhere(ctx.user), ...and] };
    const pool = await prisma.candidate.findMany({
      where,
      select: { id: true, name: true, specialization: true, education: true, skills: true, technicalSkills: true, currentDesignation: true, location: true, experienceYears: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });
    const has = (c, w) => fields.some((f) => String(c[f] || '').toLowerCase().includes(w));
    // ROLE words ("developer", "engineer", "nurse") are rarely written in a skills list: they only add to the rank, while the other words
    // (java, cardiology, react ...) must match. A question made only of role words needs one of them to match.
    const ROLE = /^(develop|engineer|nurse|teacher|professor|lecturer|consultant|technician|executive|pharmacist|accountant|supervisor|operator|analyst|manager|designer|tester|programmer|coder|specialist|surgeon|faculty)/;
    const core = q.terms.filter((w) => !ROLE.test(w));
    const roles = q.terms.filter((w) => ROLE.test(w));
    const scored = pool.map((c) => {
      const coreHits = core.filter((w) => has(c, w)).length;
      const roleHits = roles.filter((w) => has(c, w)).length;
      const qualHit = q.quals.some((ql) => [c.education, c.specialization].some((v) => String(v || '').toLowerCase().replace(/\./g, '').includes(ql.toLowerCase().replace(/\./g, ''))));
      return { c, coreHits, roleHits, qualHit, score: coreHits * 3 + roleHits + (qualHit ? 2 : 0) + (c.experienceYears || 0) / 100 };
    })
      // two of the main words when several were asked (a specialization AND a skill), the one when only one was asked
      .filter((x) => (core.length ? x.coreHits >= Math.min(core.length, 2) : (roles.length ? x.roleHits > 0 : true)) && (q.quals.length ? x.qualHit : true))
      .sort((a, b) => b.score - a.score);
    const top = scored.slice(0, q.count);
    const asked = [q.quals.join(' / '), q.shown.join(' '), q.cities.length ? `in ${q.cities.map((c) => c.label).join(' / ')}` : '', q.exp != null ? `${q.exp}+ years` : ''].filter(Boolean).join(', ') || 'your words';
    const source = `Searched the candidates you can see (specialization, skills, education, designation${view.bde ? '' : ', location'}). Your area: ${scopeText(ctx.user, 'ats')}.`;
    if (!top.length) {
      return answer(`No candidate in your access matches ${asked}. Try fewer words (for example only the specialization), or another city.`, { source, area: 'candidates', options: ['Find candidates in Hyderabad', 'Find 10 Java developers'] });
    }
    const rows = top.map(({ c }) => [c.name, [c.education, c.specialization].filter(Boolean).join(' · ') || '-', view.bde ? '-' : (c.location || '-'), c.experienceYears != null ? `${c.experienceYears} yrs` : '-']);
    return answer(`Found ${scored.length} candidate${scored.length === 1 ? '' : 's'} for ${asked}${scored.length > top.length ? `; the best ${top.length} are below` : ''}. Open Candidates & Pipeline and search the name to see a profile.`, {
      numbers: [{ label: 'Matching', value: scored.length }], rows, source, area: 'candidates',
    });
  },
});

// "Best candidates for REQ-0012" / "who should I put forward for the Java Developer job" (ATS audit 2026-11-18, Q319): the matching engine's
// own ranking (utils/matching.js through the top_matches_for_requirement tool, which checks the permission and the requirement's scope).
add({
  id: 'best-for-requirement', product: 'ats',
  test: (t) => /\b(best|top|suitable|right|matching|good)\s+(\d+\s+)?(candidates?|profiles?|matches|people)\s+(for|to)\s+(req[-\s]?\d|the |this |[a-z])/.test(t) || /who (should|can) i (put forward|submit|send|share)/.test(t) || /\breq[-\s]?\d{2,6}\b.*\b(best|top|suitable)\b/.test(t),
  async run(ctx) {
    const code = (/\b(req[-\s]?\d{2,6})\b/i.exec(ctx.text) || [])[1];
    const scope = requirementWhere(ctx.user);
    let r = null;
    if (code) r = await prisma.requirement.findFirst({ where: { AND: [scope, { reqCode: { contains: code.toUpperCase().replace(/\s/, '-') } }] }, select: { id: true, title: true, reqCode: true } });
    if (!r) {
      const after = (/\b(?:for|to)\s+(?:the\s+)?(.+?)(?:\s+(?:job|requirement|role|position|opening))?\s*\??$/i.exec(ctx.text) || [])[1];
      const words = String(after || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !SEARCH_STOP.has(w)).slice(0, 4);
      if (words.length) {
        const list = await prisma.requirement.findMany({ where: { AND: [scope, { status: 'OPEN' }, ...words.map((w) => ({ title: { contains: w } }))] }, select: { id: true, title: true, reqCode: true }, take: 3 });
        if (list.length === 1) [r] = list;
        else if (list.length > 1) return answer(`More than one open requirement matches: ${list.map((x) => `${x.reqCode || ''} ${x.title}`.trim()).join('; ')}. Ask again with the requirement code (for example "best candidates for ${list[0].reqCode || 'REQ-0001'}").`, { source: 'Searched the open requirements you can see.' });
      }
    }
    if (!r) return answer('Tell me which requirement: for example "best candidates for REQ-0012" or "best candidates for Java Developer".', { source: 'No requirement was named.', options: ['Best candidates for REQ-0001'] });
    const out = await runTool(ctx.user, 'top_matches_for_requirement', { requirementId: r.id, limit: 10 });
    if (out.denied) return answer(out.message || 'You do not have access to matching candidates.', { source: 'Checked against your role.' });
    const m = out.matches || [];
    if (!m.length) return answer(`No candidate in your access matches ${r.reqCode || ''} ${r.title} yet.`, { source: out.note || 'utils/matching.js' });
    return answer(`Best ${m.length} for ${r.reqCode ? `${r.reqCode} ` : ''}${r.title}, ranked by the matching engine (not by the AI):`, {
      rows: m.map((c) => [c.name, c.score != null ? `${c.score}%` : '-', (c.reasons || []).slice(0, 2).join('; ') || '-', (c.gaps || []).slice(0, 1).join('; ') || '-']),
      numbers: [{ label: 'Shown', value: m.length }], source: `${out.note || 'utils/matching.js'} Open the requirement > Matching candidates for the full list.`, area: 'requirements',
    });
  },
});
// these two go FIRST: a "find ... candidates" question must not be taken by a counting handler
HANDLERS.unshift(HANDLERS.pop(), HANDLERS.pop());

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function tryAnswer(user, auth, message, { now = new Date() } = {}) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const t = normalise(raw).trim();
  const analysis = engine.analyse(raw);
  const names = (analysis.nameSpans || []).map((s) => s.text).filter((n) => /^[A-Z]/.test(n) || true);
  const ctx = {
    user, reader: makeReader(auth), t: ` ${t} `, text: raw, analysis, names, today: ymd(now), period: periodOf(raw, now),
  };
  const NOT_NAMES = /^(today|tomorrow|yesterday|week|month|this|last|next|left|remaining|balance|available|total|many|much|every|everyone|everybody|employees?|people|staff|all|now|current|currently|status|summary|report|overview|pending|open|late|absent|present|there|here|ours|us|we)$/i;
  ctx.names = names.filter((n) => !NOT_NAMES.test(n) && n.length > 1);

  const selfOnly = perm.isSelfServiceOnly(user);
  // An employee asking about SOMEONE ELSE's leave, attendance or pay: no.
  if (selfOnly && ctx.names.length && /(leave|attendance|salary|payslip|pay slip|absent|present|late|timesheet|ctc)/.test(ctx.t) && !mine(ctx.t)) {
    return answer('As an employee you can only ask about your OWN leave, attendance, payslip and timesheet - not anybody else\'s. Nothing was read.', {
      source: 'Checked against your role.', options: ['How much leave do I have left?', 'My attendance this month'],
    });
  }
  for (const h of HANDLERS) {
    let hit = false;
    try { hit = h.test(ctx.t, ctx); } catch { hit = false; }
    if (!hit) continue;
    if (selfOnly && !h.self) {
      return answer('As an employee you can ask me about your OWN leave, attendance, payslip and timesheet - for example "How much leave do I have left?". Other questions are for people with a wider role.', {
        source: 'Checked against your role.', options: ['How much leave do I have left?', 'My attendance this month', 'My latest payslip'],
      });
    }
    // eslint-disable-next-line no-await-in-loop
    const out = await h.run(ctx);
    if (out) return out;
  }

  // Not a question about data: is it a request to DO something? Ask mode never does it.
  const d = engine.decide(analysis);
  const tool = d.confident ? registry.getTool(d.tool) : (d.candidates && d.candidates.length ? registry.getTool(d.candidates[0]) : null);
  if (tool && !isQ(t)) {
    return {
      handled: true,
      mode: 'ask',
      answer: `I can only look things up here - I cannot change anything in Ask mode. This sounds like an action ("${tool.label}"). Switch to Do mode and say it again, and I will show you what I am about to do and wait for your Confirm.`,
      numbers: [],
      source: 'Ask mode is read-only.',
      suggestMode: 'do',
      suggestedTool: tool.name,
      options: [],
    };
  }
  return null;
}

module.exports = { tryAnswer, periodOf, normalise, HANDLERS };
