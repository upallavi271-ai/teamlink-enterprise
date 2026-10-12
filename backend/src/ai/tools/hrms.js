// HRMS tools: own leave, attendance corrections (HR / Admin), announcements,
// assets, and employee records. Every one replays the app's own route:
//   POST /api/leave                  PATCH /api/leave/:id/cancel-request
//   POST /api/attendance             POST /api/announcements
//   PATCH /api/asset-inventory/:id/assign|return
//   POST /api/employees/management   PUT /api/employees/:id
const { defineTool } = require('../registry');
const T = require('../lib/tooling');
const entities = require('../lib/entities');
const { problemOf } = require('../lib/http');
const { niceDate, niceTime, daysBetween } = require('../lib/dates');
const { scopeOf } = require('../../utils/scope');
const S = require('./_shared');
const F = require('./_fields');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const same = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
const ATT_STATUSES = ['Present', 'Absent', 'Late', 'Half Day', 'Leave'];

// ----------------------------------------------------------------------------
// apply_leave (OWN leave)
// ----------------------------------------------------------------------------
const LEAVE_ALIASES = [
  [/\bcasual\b|\bcl\b/i, 'casual'], [/\bsick\b|\bmedical leave\b|\bsl\b|\bfever\b/i, 'sick'], [/\bearned\b|\bprivilege\b|\bel\b|\bpl\b/i, 'earned'],
  [/\bplanned\b/i, 'planned'], [/\bmaternity\b/i, 'maternity'], [/\bpaternity\b/i, 'paternity'], [/\bloss of pay\b|\blwp\b|\bunpaid\b/i, 'loss of pay'],
];

function leaveTypeFrom(text, types) {
  const names = types.map((t) => t.name);
  for (const [re, key] of LEAVE_ALIASES) {
    if (re.test(text)) {
      const hit = names.find((n) => n.toLowerCase().includes(key));
      if (hit) return hit;
    }
  }
  const direct = names.find((n) => text.toLowerCase().includes(n.toLowerCase()));
  return direct || null;
}

defineTool({
  name: 'apply_leave',
  module: 'hrms',
  label: 'Apply for my leave',
  description: 'Apply for your OWN leave: type, day(s) and a reason.',
  parameters: {
    leaveType: { type: 'enum', required: true, description: 'Casual, Sick, Planned ... (the types your company has).' },
    fromDate: { type: 'date', required: true, description: 'First day.' },
    toDate: { type: 'date', required: false, description: 'Last day (same day if you give one date).' },
    halfDay: { type: 'enum', required: false, description: 'First Half or Second Half.' },
    reason: { type: 'text', required: false, description: 'Why.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Services', action: 'view' },
  selfService: true,
  confirm: 'default',
  examples: ['Apply casual leave tomorrow', 'I need sick leave on Monday', 'Naaku repu casual leave kavali'],
  async validate(ctx, input) {
    const me = await entities.ownEmployee(ctx.user);
    if (!me) return T.refuse('Your login has no employee record, so there is no leave for you to apply. Ask HR to link your record.');
    const tr = await ctx.read.get('/leave/types');
    const types = (tr.ok && Array.isArray(tr.data) ? tr.data : []).filter((t) => t.active !== false);
    if (!types.length) return T.refuse('No leave types are set up yet. Ask HR.');
    let type = (input.choices && input.choices.leaveType) || leaveTypeFrom(input.text, types) || null;
    if (type && !types.some((t) => t.name === type)) type = null;
    if (!type) {
      if (types.length === 1) type = types[0].name;
      else {
        return T.clarify('Which type of leave?', { need: 'leaveType', options: types.slice(0, 6).map((t) => ({ label: t.name, choice: { leaveType: t.name } })) });
      }
    }
    const dates = input.slots.dates || [];
    if (!dates.length) return T.clarify('For which day (or days) do you want the leave?', { need: 'when' });
    const half = /half[\s-]?day|\bhalf\b/i.test(input.text)
      ? (/second half|afternoon|evening|after lunch|pm\b/i.test(input.text) ? 'Second Half' : 'First Half') : null;
    const from = dates[0];
    let to = dates.length > 1 ? dates[dates.length - 1] : from;
    if (half) to = from;
    if (to < from) return T.refuse('The last day is before the first day. Which dates did you mean?');
    const calendarDays = daysBetween(from, to) + 1;
    if (calendarDays > 60) return T.refuse('That is more than 60 days. Please check the dates.');
    const av = await ctx.read.get('/leave/availability');
    let balanceLine = null;
    if (av.ok && av.data && Array.isArray(av.data.types)) {
      const row = av.data.types.find((t) => t.type === type);
      if (row && row.limited) {
        const need = half ? 0.5 : calendarDays;
        if (need > row.available) {
          return T.refuse(`You have ${row.available} day(s) of ${type} available (${row.remaining} left, ${row.pending} waiting for a decision) and asked for ${need}. I did not apply.`);
        }
        balanceLine = `${row.available} day(s) available now`;
      }
    }
    const reason = T.reasonText(input, 'reason');
    const days = half ? 0.5 : calendarDays;
    return T.done({
      params: { employeeId: me.id, type, fromDate: from, toDate: to, halfDay: half, reason: reason || null },
      summary: `Apply for ${type}: ${half ? `${niceDate(from)} (${half})` : (from === to ? niceDate(from) : `${niceDate(from)} to ${niceDate(to)}`)}.`,
      display: T.card('Apply Leave', [
        ['Employee', me.name], ['Leave type', type], ['From', niceDate(from)], ['To', niceDate(to)], ['Half day', half], ['Days asked', `${days} (weekly offs and holidays are handled by the leave policy)`],
        ['Balance', balanceLine], ['Reason', reason || '(not given)'],
      ], 'Your request goes to your approver. Nothing is approved by me.'),
    });
  },
  async rules(ctx, p) {
    const me = await entities.ownEmployee(ctx.user);
    if (!me || me.id !== p.employeeId) return { ok: false, message: 'This leave is not for your own record, so I did not apply it.' };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/leave', {
      type: p.type, fromDate: p.fromDate, toDate: p.toDate, ...(p.halfDay ? { halfDay: p.halfDay } : {}), ...(p.reason ? { reason: p.reason } : {}),
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.type} requested - it is waiting for approval.`, data: { id: r.data.id, status: r.data.status } };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    const r = await ctx.read.get(`/leave?employeeId=${encodeURIComponent(p.employeeId)}`);
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.id === id) : null;
    const ok = !!row && row.type === p.type && row.fromDate === p.fromDate && row.toDate === p.toDate;
    return { ok, message: ok ? `It shows in your leave list as ${row.status}.` : 'I could not find the request in your leave list.', evidence: { id, status: row ? row.status : null } };
  },
  audit: (p) => `Applied ${p.type} ${p.fromDate}..${p.toDate}`,
});

// ----------------------------------------------------------------------------
// cancel_leave (OWN pending leave)
// ----------------------------------------------------------------------------
defineTool({
  name: 'cancel_leave',
  module: 'hrms',
  label: 'Cancel my leave request',
  description: 'Ask to cancel one of your OWN waiting leave requests.',
  parameters: {
    leave: { type: 'leave', required: true, description: 'Which request (by day, or the only waiting one).' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Services', action: 'view' },
  selfService: true,
  confirm: 'default',
  examples: ['Cancel my leave', 'Cancel my leave request for tomorrow', 'Withdraw my pending leave'],
  async validate(ctx, input) {
    const me = await entities.ownEmployee(ctx.user);
    if (!me) return T.refuse('Your login has no employee record, so there is no leave to cancel.');
    const r = await ctx.read.get(`/leave?employeeId=${encodeURIComponent(me.id)}&status=Pending`);
    const rows = (r.ok && Array.isArray(r.data) ? r.data : []).filter((x) => x.employeeId === me.id && x.status === 'Pending');
    if (!rows.length) return T.refuse('You have no leave request waiting for a decision, so there is nothing to cancel.');
    let pick = null;
    if (input.choices && input.choices.leave) pick = rows.find((x) => x.id === input.choices.leave);
    if (!pick) {
      const dates = input.slots.dates || [];
      const byDate = dates.length ? rows.filter((x) => dates.some((d) => d >= x.fromDate && d <= x.toDate)) : rows;
      if (byDate.length === 1) pick = byDate[0];
      else if (byDate.length > 1) {
        return T.which('Which leave request?', byDate.map((x) => ({ id: x.id, label: `${x.type}: ${niceDate(x.fromDate)}${x.toDate !== x.fromDate ? ` to ${niceDate(x.toDate)}` : ''}` })), 'leave');
      } else return T.refuse('None of your waiting requests is on that day.');
    }
    return T.done({
      params: { leaveId: pick.id, type: pick.type, fromDate: pick.fromDate, toDate: pick.toDate },
      summary: `Ask to cancel your ${pick.type} request for ${niceDate(pick.fromDate)}${pick.toDate !== pick.fromDate ? ` to ${niceDate(pick.toDate)}` : ''}.`,
      display: T.card('Cancel Leave', [['Leave type', pick.type], ['From', niceDate(pick.fromDate)], ['To', niceDate(pick.toDate)], ['Now', pick.status]]),
    });
  },
  async rules(ctx, p) {
    const me = await entities.ownEmployee(ctx.user);
    const r = await ctx.read.get(`/leave?employeeId=${encodeURIComponent(me ? me.id : '')}`);
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.id === p.leaveId) : null;
    if (!row || (me && row.employeeId !== me.id)) return { ok: false, message: 'I cannot find that request in your own list. Nothing was changed.' };
    if (row.status !== 'Pending') return { ok: false, message: `That request is now ${row.status}. Nothing was changed.` };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/leave/${encodeURIComponent(p.leaveId)}/cancel-request`, {});
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: 'Cancellation requested.', data: r.data };
  },
  async verify(ctx, p) {
    const me = await entities.ownEmployee(ctx.user);
    const r = await ctx.read.get(`/leave?employeeId=${encodeURIComponent(me ? me.id : '')}`);
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.id === p.leaveId) : null;
    const ok = !!row && /cancel/i.test(row.status);
    return { ok, message: ok ? `The request now shows: ${row.status}.` : 'The request does not show as cancelled.', evidence: { status: row ? row.status : null } };
  },
  audit: (p) => `Asked to cancel leave ${p.leaveId}`,
});

// ----------------------------------------------------------------------------
// update_attendance (HR / Admin roles only)
// ----------------------------------------------------------------------------
function attendanceStatusFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/half[\s-]?day/.test(t)) return 'Half Day';
  if (/\babsent\b/.test(t)) return 'Absent';
  if (/\blate\b/.test(t)) return 'Late';
  if (/\bpresent\b|\bin office\b|\battended\b/.test(t)) return 'Present';
  if (/\bleave\b|\bon leave\b/.test(t)) return 'Leave';
  return null;
}

defineTool({
  name: 'update_attendance',
  module: 'hrms',
  label: 'Correct someone\'s attendance',
  description: 'Mark or correct one person\'s attendance for one day. HR and Admin roles only.',
  parameters: {
    employee: { type: 'person', required: true, description: 'The employee.' },
    date: { type: 'date', required: false, description: 'The day (today if not said).' },
    status: { type: 'enum', required: true, description: 'Present, Absent, Late, Half Day or Leave.' },
    checkIn: { type: 'time', required: false, description: 'Check-in time.' },
    checkOut: { type: 'time', required: false, description: 'Check-out time.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Management', action: 'view' },
  async roles(user) {
    const s = scopeOf(user);
    const ok = ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(s.hrmsRole) || ['SUPER_ADMIN', 'ADMIN', 'HR'].includes(user.role);
    return ok ? true : { ok: false, message: 'Only HR and Admin roles can change someone\'s attendance. You can ask for a regularization on your own attendance instead. Nothing was changed.' };
  },
  confirm: 'always',
  impact: 'Attendance feeds payroll and leave, so a correction always needs your Confirm.',
  examples: ['Mark Ravi present for today', "Update Priya's attendance to absent on Monday"],
  async validate(ctx, input) {
    const emp = await S.pickEmployee(ctx, input, { question: 'Whose attendance?' });
    if (emp.ret) return emp.ret;
    const e = emp.one;
    const status = (input.choices && input.choices.status) || attendanceStatusFrom(input.text);
    if (!status || !ATT_STATUSES.includes(status)) {
      return T.clarify(`What should ${e.name}'s attendance be?`, { need: 'status', options: ATT_STATUSES.map((s) => ({ label: s, choice: { status: s, employee: e.id } })) });
    }
    const date = (input.slots.dates || [])[0] || ctx.today;
    if (date > ctx.today) return T.refuse('Attendance cannot be marked for a day that has not come yet.');
    const times = input.slots.times || [];
    const checkIn = /check[\s-]?in|in time|came at|arrived/i.test(input.text) || times.length > 1 ? times[0] || null : null;
    const checkOut = times.length > 1 ? times[1] : (/check[\s-]?out|left at|out time/i.test(input.text) && times.length === 1 && !checkIn ? times[0] : null);
    const cur = await ctx.read.get(`/attendance?employeeId=${encodeURIComponent(e.id)}&date=${date}`);
    const row = cur.ok && Array.isArray(cur.data) ? cur.data.find((x) => x.date === date) : null;
    if (row && row.status === status && (!checkIn || row.checkIn === checkIn) && (!checkOut || row.checkOut === checkOut)) {
      return T.refuse(`${e.name} is already marked ${status} on ${niceDate(date)}. Nothing to change.`);
    }
    return T.done({
      params: { employeeId: e.id, name: e.name, date, status, checkIn, checkOut, previous: row ? row.status : null },
      summary: `Mark ${e.name} as ${status} on ${niceDate(date)}.`,
      display: T.card('Update Attendance', [
        ['Employee', e.name], ['Date', niceDate(date)], ['Current', row ? row.status : '(not marked)'], ['New', status], ['Check-in', checkIn ? niceTime(checkIn) : null], ['Check-out', checkOut ? niceTime(checkOut) : null],
      ]),
    });
  },
  async rules(ctx, p) {
    const e = await entities.employeeById(ctx.user, p.employeeId);
    return e ? { ok: true } : { ok: false, message: 'That employee is not in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/attendance', {
      employeeId: p.employeeId, date: p.date, status: p.status, ...(p.checkIn ? { checkIn: p.checkIn } : {}), ...(p.checkOut ? { checkOut: p.checkOut } : {}),
    });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.name} is marked ${p.status} for ${niceDate(p.date)}.`, data: r.data };
  },
  async verify(ctx, p) {
    const r = await ctx.read.get(`/attendance?employeeId=${encodeURIComponent(p.employeeId)}&date=${p.date}`);
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.date === p.date) : null;
    const ok = !!row && row.status === p.status;
    return { ok, message: ok ? 'The attendance record shows it.' : 'The attendance record shows something different.', evidence: { status: row ? row.status : null } };
  },
  audit: (p) => `Attendance ${p.employeeId} ${p.date} -> ${p.status}`,
});

// ----------------------------------------------------------------------------
// create_announcement
// ----------------------------------------------------------------------------
function announcementParts(input) {
  const q = (input.slots.quoted || [])[0];
  let body = q || '';
  if (!body) {
    const m = String(input.text || '').match(/\b(?:announce(?:ment)?|circular|broadcast|notice)\b\s*(?:that|about|:|-|saying)?\s*[:\-]?\s*(.+)$/i);
    body = m ? m[1] : '';
  }
  body = S.CLEAN(body).replace(/^(?:that|about|:|-)\s*/i, '');
  body = body.charAt(0).toUpperCase() + body.slice(1);
  const titleM = String(input.text || '').match(/\btitle\s*(?:is|:)?\s*"?([^"\n,;]{3,80})"?/i);
  return { body, title: titleM ? S.CLEAN(titleM[1]) : '' };
}

defineTool({
  name: 'create_announcement',
  module: 'hrms',
  label: 'Post an announcement',
  description: 'Post a company announcement to everyone, or to one department.',
  parameters: {
    title: { type: 'text', required: true, description: 'A short heading.' },
    body: { type: 'text', required: true, description: 'What it says.' },
    category: { type: 'enum', required: false, description: 'General, Policy, Event or Holiday.' },
    target: { type: 'text', required: false, description: 'All Employees, or a department.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Services', action: 'create' },
  confirm: 'always',
  impact: 'An announcement reaches many people at once, so it always needs your Confirm.',
  examples: ['Announce that office is closed on Friday', 'Post an announcement: Diwali holiday on 20 Oct'],
  async validate(ctx, input) {
    const { body, title: typedTitle } = announcementParts(input);
    const answered = input.slots.answers && input.slots.answers.body;
    const text = S.CLEAN(answered || body);
    if (!text || text.length < 4) return T.clarify('What should the announcement say?', { need: 'body' });
    if (text.length > 1500) return T.refuse('That is too long for an announcement. Please shorten it to a few lines.');
    let title = typedTitle || (input.slots.answers && input.slots.answers.title) || '';
    if (!title) {
      const firstSentence = text.split(/[.!?]/)[0];
      title = S.CLEAN(firstSentence).slice(0, 70);
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }
    const category = /holiday|diwali|festival|dussehra|sankranti|closed|off\b/i.test(text) ? 'Holiday'
      : /policy|rule|attendance|leave policy|dress code/i.test(text) ? 'Policy'
        : /party|outing|event|celebrat|meeting|training|picnic/i.test(text) ? 'Event' : 'General';
    // Who? "to all employees" (default) or a department that really exists.
    let target = 'All Employees';
    const opt = await ctx.read.get('/employees/management/options');
    const depts = opt.ok && Array.isArray(opt.data.departments) ? opt.data.departments.map((d) => (typeof d === 'string' ? d : d.name)).filter(Boolean) : [];
    const lowText = input.text.toLowerCase();
    const named = depts.find((d) => new RegExp(`\\b${d.toLowerCase().replace(/[^a-z0-9& ]/g, '.')}\\b`).test(lowText) && /(team|department|dept|for|to)\b/.test(lowText));
    if (named && !/all employees|everyone|everybody|all staff/.test(lowText)) target = named;
    return T.done({
      params: { title, body: text, category, target, date: ctx.today },
      summary: `Post the ${category} announcement "${title}" to ${target}.`,
      display: T.card('Post Announcement', [['Title', title], ['Message', text], ['Category', category], ['Goes to', target]], 'Everyone it reaches is told in the app.'),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/announcements', p);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `Announcement "${p.title}" posted${r.data.reached != null ? ` to ${r.data.reached} people` : ''}.`, data: { id: r.data.id } };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    const r = await ctx.read.get('/announcements');
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.id === id) : null;
    const ok = !!row && same(row.title, p.title);
    return { ok, message: ok ? 'It is on the announcements list.' : 'I could not find it on the announcements list.', evidence: { id } };
  },
  audit: (p) => `Posted announcement "${p.title}" to ${p.target}`,
});

// ----------------------------------------------------------------------------
// assign_asset / return_asset
// ----------------------------------------------------------------------------
const ASSET_WORDS = /\b(laptop|mobile|charger|monitor|mouse|keyboard|sim|id card|headset|tablet|desktop|printer|pendrive|ups|macbook|dell|lenovo|hp)\b/i;

async function pickAsset(ctx, input, { statusIn = null, holderId = null } = {}) {
  const code = (input.slots.codes || []).find((c) => /^AST/i.test(c)) || null;
  const word = (String(input.text || '').match(ASSET_WORDS) || [])[1] || '';
  const all = await entities.findAssets(ctx.read, { code, text: code ? '' : word });
  if (all.denied) return { ret: T.refuse('Your role cannot see the asset register.') };
  let rows = all.rows;
  if (input.choices && input.choices.asset) rows = rows.filter((a) => a.id === input.choices.asset);
  if (statusIn) rows = rows.filter((a) => statusIn.includes(a.status));
  if (holderId) rows = rows.filter((a) => a.holderId === holderId);
  if (!rows.length) {
    return { ret: T.refuse(code
      ? `I cannot find asset ${code}${statusIn ? ` that is ${statusIn.join(' / ').toLowerCase()}` : ''} in your register.`
      : `I cannot find a matching asset${word ? ` ("${word}")` : ''}${statusIn ? ` that is ${statusIn.join(' / ').toLowerCase()}` : ''}. Give me the asset code (like AST-0012).`) };
  }
  if (rows.length === 1) return { one: rows[0] };
  return { ret: T.which(`I found ${rows.length} matching assets. Which one?`, rows, 'asset') };
}

defineTool({
  name: 'assign_asset',
  module: 'hrms',
  label: 'Give an asset to an employee',
  description: 'Hand a company asset (laptop, mobile, charger ...) to an employee.',
  parameters: {
    asset: { type: 'asset', required: true, description: 'The asset (code like AST-0012, or its kind).' },
    employee: { type: 'person', required: true, description: 'Who gets it.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Services', action: 'edit' },
  confirm: 'default',
  examples: ['Assign laptop AST-0012 to Ravi', 'Give Priya a laptop'],
  async validate(ctx, input) {
    const emp = await S.pickEmployee(ctx, input, { question: 'Who should get the asset?' });
    if (emp.ret) return emp.ret;
    const e = emp.one;
    const a = await pickAsset(ctx, input, { statusIn: ['Available'] });
    if (a.ret) return a.ret;
    const asset = a.one;
    return T.done({
      params: { assetId: asset.id, assetCode: asset.code, assetName: asset.name, employeeId: e.id, employeeName: e.name },
      summary: `Give ${asset.name} [${asset.code}] to ${e.name}.`,
      display: T.card('Assign Asset', [['Asset', `${asset.name} [${asset.code}]`], ['Now', asset.status], ['Give to', e.name], ['Department', e.department]]),
    });
  },
  async rules(ctx, p) {
    const all = await entities.findAssets(ctx.read, { code: p.assetCode });
    const a = all.rows.find((x) => x.id === p.assetId);
    if (!a) return { ok: false, message: 'I cannot find that asset in your register any more. Nothing was changed.' };
    if (a.status !== 'Available') return { ok: false, message: `${a.name} is now "${a.status}"${a.holder ? ` (with ${a.holder})` : ''}, so it cannot be given out. Nothing was changed.` };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/asset-inventory/${encodeURIComponent(p.assetId)}/assign`, { employeeId: p.employeeId });
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.assetName} is now with ${p.employeeName}.`, data: r.data };
  },
  async verify(ctx, p) {
    const all = await entities.findAssets(ctx.read, { code: p.assetCode });
    const a = all.rows.find((x) => x.id === p.assetId);
    const ok = !!a && a.holderId === p.employeeId && a.status === 'Assigned';
    return { ok, message: ok ? `The register shows ${p.assetName} with ${p.employeeName}.` : 'The register shows something different.', evidence: { holder: a ? a.holder : null, status: a ? a.status : null } };
  },
  audit: (p) => `Assigned asset ${p.assetCode} to employee ${p.employeeId}`,
});

defineTool({
  name: 'return_asset',
  module: 'hrms',
  label: 'Take an asset back',
  description: 'Record that an employee has returned a company asset.',
  parameters: {
    asset: { type: 'asset', required: true, description: 'The asset (code, or the kind plus who had it).' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Services', action: 'edit' },
  confirm: 'default',
  examples: ['Return laptop AST-0012', 'Take back the charger AST-0004 from Anil'],
  async validate(ctx, input) {
    // Who had it? A name span that is an employee narrows the search.
    let holderId = null;
    const code = (input.slots.codes || []).find((c) => /^AST/i.test(c));
    if (!code && T.nameSpans(input).length) {
      const hit = await F.locate(T.nameSpans(input), (s) => entities.findEmployees(ctx.user, s));
      if (hit) { const dec = entities.decide(hit.res); if (dec.one) holderId = dec.one.id; }
    }
    const a = await pickAsset(ctx, input, { statusIn: ['Assigned', 'In Repair'], holderId });
    if (a.ret) return a.ret;
    const asset = a.one;
    if (!asset.holder) return T.refuse(`${asset.name} [${asset.code}] is not with anyone, so there is nothing to take back.`);
    return T.done({
      params: { assetId: asset.id, assetCode: asset.code, assetName: asset.name, holderName: asset.holder },
      summary: `Take ${asset.name} [${asset.code}] back from ${asset.holder}.`,
      display: T.card('Return Asset', [['Asset', `${asset.name} [${asset.code}]`], ['With', asset.holder], ['After', 'Available']]),
    });
  },
  async rules(ctx, p) {
    const all = await entities.findAssets(ctx.read, { code: p.assetCode });
    const a = all.rows.find((x) => x.id === p.assetId);
    if (!a) return { ok: false, message: 'I cannot find that asset in your register any more. Nothing was changed.' };
    if (!a.holder) return { ok: false, message: `${a.name} is not with anyone now. Nothing was changed.` };
    return { ok: true };
  },
  async execute(ctx, p) {
    const r = await ctx.api.patch(`/asset-inventory/${encodeURIComponent(p.assetId)}/return`, {});
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.assetName} is back in stock.`, data: r.data };
  },
  async verify(ctx, p) {
    const all = await entities.findAssets(ctx.read, { code: p.assetCode });
    const a = all.rows.find((x) => x.id === p.assetId);
    const ok = !!a && !a.holder && a.status === 'Available';
    return { ok, message: ok ? 'The register shows it as Available.' : 'The register shows something different.', evidence: { status: a ? a.status : null } };
  },
  audit: (p) => `Returned asset ${p.assetCode}`,
});

// ----------------------------------------------------------------------------
// create_employee / update_employee
// ----------------------------------------------------------------------------
defineTool({
  name: 'create_employee',
  module: 'hrms',
  label: 'Add a new employee',
  description: 'Create a new employee record and login (name, email, department).',
  parameters: {
    name: { type: 'text', required: true, description: 'Full name.' },
    email: { type: 'email', required: true, description: 'Work email.' },
    department: { type: 'enum', required: true, description: 'Department.' },
    phone: { type: 'phone', required: false, description: 'Mobile.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Management', action: 'create' },
  confirm: 'always',
  impact: 'This creates a login and sends the person a welcome email, so it always needs your Confirm.',
  examples: ['Add employee Suresh Kumar email suresh@company.com department Medical', 'Onboard a new joiner Deepa Nair deepa@company.in'],
  async validate(ctx, input) {
    const answers = input.slots.answers || {};
    const email = (input.slots.emails || [])[0] || '';
    const spans = input.slots.spans || [];
    const nameSpan = spans.find((s) => !['in', 'at', 'department', 'dept'].includes(s.prev)) || spans[0];
    const name = S.CLEAN(answers.name || F.afterKeyword(input.text, ['employee', 'joiner', 'staff member', 'staff']) || (nameSpan && nameSpan.text) || '');
    if (!name) return T.clarify('What is the new employee\'s full name?', { need: 'name' });
    if (!email) return T.clarify(`What is ${name}'s work email?`, { need: 'email' });
    if (!EMAIL_RE.test(email)) return T.refuse(`"${email}" does not look like an email address.`);
    const opt = await ctx.read.get('/employees/management/options');
    if (!opt.ok) return T.refuse(problemOf(opt, 'You cannot see the department list.'));
    const depts = (opt.data.departments || []).map((d) => (typeof d === 'string' ? d : d.name)).filter(Boolean);
    const low = `${input.text} ${answers.department || ''}`.toLowerCase();
    const choice = input.choices && input.choices.department;
    const dept = choice || depts.find((d) => new RegExp(`(^|[^a-z0-9])${d.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(low));
    if (!dept) {
      return T.clarify(`Which department is ${name} joining?`, { need: 'department', options: depts.slice(0, 8).map((d) => ({ label: d, choice: { department: d } })) });
    }
    if (!depts.includes(dept)) return T.refuse(`"${dept}" is not a department you can add people to.`);
    const phone = (input.slots.phones || [])[0] || '';
    return T.done({
      params: { name, email, department: dept, ...(phone ? { phone } : {}) },
      summary: `Add the employee ${name} (${email}) to ${dept}.`,
      display: T.card('Add Employee', [['Name', name], ['Email', email], ['Department', dept], ['Mobile', phone]],
        'A login is made and a welcome email with a set-password link goes to this address.'),
    });
  },
  async execute(ctx, p) {
    const r = await ctx.api.post('/employees/management', p);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.name} added as ${r.data.employeeCode || 'a new employee'}.`, data: { id: r.data.id, employeeCode: r.data.employeeCode } };
  },
  async verify(ctx, p, result) {
    const id = result.data && result.data.id;
    if (!id) return { ok: false, message: 'The app did not give the new employee an id.' };
    const r = await ctx.read.get(`/employees/management/${encodeURIComponent(id)}`);
    const d = r.ok && r.data && (r.data.employee || r.data);
    const ok = !!d && same(d.email, p.email);
    return { ok, message: ok ? `${p.name} is on the employee list.` : 'I could not find the new employee when I looked.', evidence: { id } };
  },
  audit: (p) => `Created employee "${p.name}" in ${p.department}`,
});

const EMP_FIELDS = [
  { key: 'phone', label: 'Mobile' }, { key: 'designation', label: 'Designation' }, { key: 'department', label: 'Department' }, { key: 'team', label: 'Team' },
  { key: 'location', label: 'City' }, { key: 'employmentStatus', label: 'Status' },
];
const STATUSES = ['Active', 'Notice Period', 'Relieved', 'Inactive', 'Terminated'];

defineTool({
  name: 'update_employee',
  module: 'hrms',
  label: 'Change an employee\'s record',
  description: 'Change an employee\'s mobile, designation, department, team, city or status (deactivation).',
  parameters: {
    employee: { type: 'person', required: true, description: 'The employee.' },
    changes: { type: 'fields', required: true, description: 'What to change.' },
  },
  permission: { product: 'hrms', module: 'hrms', feature: 'Employee Management', action: 'edit' },
  confirm: 'always',
  impact: 'Changes to an employee record (department, role, status) affect their access and pay, so they always need your Confirm.',
  examples: ['Update employee Suresh phone to 9876543210', "Change Anita's designation to Senior Recruiter"],
  async validate(ctx, input) {
    const text = input.text;
    const asked = {};
    if ((input.slots.phones || [])[0]) asked.phone = input.slots.phones[0];
    const des = F.grab(text, ['designation']);
    if (des) asked.designation = des;
    const dep = F.grab(text, ['department', 'dept']);
    if (dep) asked.department = dep;
    const team = F.grab(text, ['team']);
    if (team) asked.team = team;
    const loc = F.grab(text, ['location', 'city']);
    if (loc) asked.location = loc;
    if (/deactivat|terminat|relieve|resign|inactive/i.test(text)) asked.employmentStatus = /terminat/i.test(text) ? 'Terminated' : (/relieve|resign/i.test(text) ? 'Relieved' : 'Inactive');
    const stM = F.grab(text, ['status']);
    if (stM) { const hit = STATUSES.find((s) => same(s, stM)); if (hit) asked.employmentStatus = hit; }
    if (/move\b.*\bto\b.*\bdepartment|moved? to .* department/i.test(text) && !asked.department) {
      const m = text.match(/\bto\s+(?:the\s+)?([A-Za-z&][A-Za-z& ]+?)\s+(?:department|dept)\b/i);
      if (m) asked.department = S.CLEAN(m[1]);
    }
    const spans = T.nameSpans(input).filter((s) => ![asked.designation, asked.department, asked.team, asked.location].some((v) => v && same(v, s)));
    let emp;
    if (input.choices && input.choices.employee) {
      emp = await entities.employeeById(ctx.user, input.choices.employee);
      if (!emp) return T.refuse('I cannot find that employee in your list any more.');
    } else {
      if (!spans.length) return T.clarify('Which employee?', { need: 'person' });
      const hit = await F.locate(spans, (s) => entities.findEmployees(ctx.user, s));
      if (!hit) return T.refuse(`I cannot find an employee called "${spans[0]}" among the people you can see.`);
      const dec = entities.decide(hit.res);
      if (!dec.one) return T.which(`I found ${hit.res.rows.length} people that fit "${hit.span}". Which one?`, hit.res.rows, 'employee');
      emp = dec.one;
    }
    if (!Object.keys(asked).length) return T.clarify(`What should I change on ${emp.name}? (mobile, designation, department, team, city, or deactivate)`, { need: 'changes' });
    const changes = {};
    const rows = [['Employee', `${emp.name}${emp.employeeCode ? ` (${emp.employeeCode})` : ''}`]];
    EMP_FIELDS.forEach((f) => {
      if (asked[f.key] === undefined || same(emp[f.key], asked[f.key])) return;
      changes[f.key] = asked[f.key];
      rows.push([`${f.label} - now`, emp[f.key] || '(empty)']);
      rows.push([`${f.label} - new`, asked[f.key]]);
    });
    if (!Object.keys(changes).length) return T.refuse(`${emp.name} already has those details. Nothing to change.`);
    return T.done({
      params: { employeeId: emp.id, name: emp.name, changes },
      summary: `Change ${emp.name}: ${Object.entries(changes).map(([k, v]) => `${EMP_FIELDS.find((f) => f.key === k).label} to ${v}`).join(', ')}.`,
      display: T.card('Change Employee', rows, changes.employmentStatus ? 'Changing the status can switch off their access.' : null),
    });
  },
  async rules(ctx, p) {
    const e = await entities.employeeById(ctx.user, p.employeeId);
    return e ? { ok: true } : { ok: false, message: 'That employee is not in your list any more. Nothing was changed.' };
  },
  async execute(ctx, p) {
    const r = await ctx.api.put(`/employees/${encodeURIComponent(p.employeeId)}`, p.changes);
    if (!r.ok) return { ok: false, message: problemOf(r, 'The app did not allow that.') };
    return { ok: true, message: `${p.name} updated.`, data: r.data };
  },
  async verify(ctx, p) {
    const e = await entities.employeeById(ctx.user, p.employeeId);
    if (!e) return { ok: false, message: 'I could not read the employee back.' };
    const bad = Object.entries(p.changes).filter(([k, v]) => !same(e[k], v)).map(([k]) => k);
    return { ok: !bad.length, message: bad.length ? `These did not save: ${bad.join(', ')}.` : 'The new details are on the employee record.', evidence: { checked: Object.keys(p.changes) } };
  },
  audit: (p) => `Updated employee ${p.employeeId}: ${Object.keys(p.changes).join(', ')}`,
});
