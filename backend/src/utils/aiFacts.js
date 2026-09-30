// ---------------------------------------------------------------------------
// The FACTS block for the AI Assistant — everything the model may state about
// this company or this user, and nothing else.
//
// WHERE THE NUMBERS COME FROM. Every section below is one of the permission-
// checked, scope-filtered READ functions in utils/aiAgentTools.js and
// utils/aiAgentReadTools.js — the same can() + utils/scope.js fragments the
// screens' own routes use — so the assistant cannot disagree with what the
// user sees on screen, and cannot see more than they can. A read the user is
// not allowed comes back `denied` and its section is simply left out.
//
// IDENTITY COMES FROM THE SESSION. buildFacts() takes req.user and nothing
// the browser said about itself. The only client hint is the page path, and
// it decides ORDER — ATS facts first on an ATS screen, HRMS facts first on an
// HRMS screen, a company overview on the main dashboard — never who the user
// is or what they may read.
//
// DB TEXT IS DATA. Names, reasons and announcement text are flattened to one
// line, trimmed, and stripped of anything that looks like the FACTS markers,
// so a record cannot close the block or pose as an instruction.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { can } = require('./permissions');
const { requirementWhere, scopeLabel, scopeDepartments } = require('./scope');
const { runTool } = require('./aiAgentTools');
const { atsRoleLabel, REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');

// The block is capped. Sections are written in priority order, and whatever
// does not fit at the end is dropped — which is always the least relevant
// area. The caller picks the cap: a local CPU model reads a prompt slowly
// (every 1,000 characters is a noticeable wait), a hosted one does not.
const DEFAULT_MAX_FACTS_CHARS = 9000;

function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in this server's timezone
}

function weekday(d = new Date()) {
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

// One line of DB text, safe to put in a prompt.
function clean(value, max = 120) {
  const s = String(value == null ? '' : value)
    .replace(/={3,}/g, '=')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// Which part of the app a path belongs to — the same split as the frontend's
// nav.js SECTION_OF_PATH.
function areaOf(page) {
  const p = String(page || '/').split('?')[0];
  if (/^\/(hrms|attendance|leave|payroll|performance|employee-services|my-profile|employees)(\/|$)/.test(p)) return 'hrms';
  if (/^\/(ats|requirements|clients|candidates|client-portal)(\/|$)/.test(p)) return 'ats';
  if (/^\/(accounts|invoices|bank|office)(\/|$)/.test(p)) return 'accounts';
  if (p === '/' || p === '' || p === '/dashboard') return 'home';
  return 'other';
}

// WHICH PART OF THE APP A QUESTION IS ABOUT — by its words, whatever page it
// was asked from. "How many leaves do I have" is HRMS on the Invoices screen
// too; the answer must come from HRMS facts, so those go first and the
// question's own area is the one given in full. null = the question does not
// say (then the page decides). Telugu-English words included, as the team
// types them.
// Word stems per area; a stem ending in "*" matches any ending.
const TOPIC_WORDS = {
  hrms: ['leave', 'leaves', 'holiday', 'holidays', 'attendance', 'check in', 'checkin', 'check out', 'punch*', 'regulari*',
    'payslip*', 'payroll', 'salary', 'salaries', 'ctc', 'lms', 'course*', 'training', 'certificate*', 'performance',
    'appraisal*', 'kpi*', 'goal*', 'resign*', 'notice period', 'exit', 'reward*', 'employee*', 'staff', 'hr', 'hrms',
    'shift*', 'timesheet*', 'helpdesk', 'ticket*', 'asset*', 'document*', 'profile', 'birthday*', 'anniversar*',
    'selavu', 'selavulu', 'jeetham', 'hajaru', 'haajaru'],
  ats: ['candidate*', 'requirement*', 'req', 'reqs', 'job', 'jobs', 'opening*', 'position*', 'client*', 'interview*',
    'pipeline', 'shortlist*', 'selected', 'joining*', 'joined', 'offer*', 'recruit*', 'bde', 'tl', 'stl', 'job portal',
    'naukri', 'shine', 'linkedin', 'indeed', 'source*', 'follow up*', 'followup*', 'agreement*', 'placement*', 'ats',
    'resume*', 'cv', 'cvs'],
  accounts: ['invoice*', 'billing', 'billed', 'payment*', 'receiv*', 'payable*', 'gst', 'gstin', 'tds', 'pan', 'tan',
    'expense*', 'vendor*', 'bank', 'reconcil*', 'ledger*', 'profit', 'loss', 'p&l', 'revenue', 'income', 'account',
    'accounts', 'outstanding', 'dues', 'traces', 'challan*', 'amount*', 'rupee*'],
};
// One regex per area: whole words only; "check in" also matches "check-in".
const escapeRe = (w) => w.replace(/[.+?^(){}$|[\]\\]/g, (c) => '\\' + c);
const TOPIC_RE = Object.fromEntries(Object.entries(TOPIC_WORDS).map(([area, words]) => {
  const alts = words.map((w) => escapeRe(w.replace(/\*$/, '')).replace(/ /g, '[\\s-]?') + (w.endsWith('*') ? '[a-z]*' : ''));
  return [area, new RegExp('(?:^|[^a-z0-9&])(?:' + alts.join('|') + ')(?=$|[^a-z0-9])', 'gi')];
}));
function topicOf(text) {
  const s = String(text || '').toLowerCase();
  const hits = Object.entries(TOPIC_RE).map(([area, re]) => [area, (s.match(re) || []).length])
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!hits.length) return null;
  // A tie between areas says nothing; let the page decide.
  if (hits.length > 1 && hits[0][1] === hits[1][1]) return null;
  return hits[0][0];
}

// Run one read tool; a refusal, a not-applicable or a failure is "no section".
async function read(user, name, input = {}) {
  try {
    const out = await runTool(user, name, input);
    if (!out || out.denied || out.error || out.notApplicable) return null;
    return out;
  } catch {
    return null;
  }
}

// --- Sections --------------------------------------------------------------
// Each returns { title, lines } or null. `rich` = this is the page's own area,
// so it gets more rows.

async function sectionMyHr(user, rich) {
  if (!user.employeeId) {
    return { title: 'YOUR HR RECORD', lines: ['This login has no employee record, so it has no personal leave, attendance or payslip data.'] };
  }
  const [profile, leave, attendance, tasks] = await Promise.all([
    read(user, 'my_profile_status'),
    read(user, 'my_leave'),
    read(user, 'my_attendance', {}),
    read(user, 'my_tasks', { mine: true, openOnly: true }),
  ]);
  const lines = [];
  if (profile) {
    lines.push(`Employee code ${clean(profile.employeeCode, 40)}; department ${clean(profile.department || 'not set', 60)}; designation ${clean(profile.designation || 'not set', 60)}; reporting manager ${clean(profile.reportingManager || 'not set', 60)}.`);
    lines.push(`Date of joining ${profile.dateOfJoining || 'not recorded'}; employment status ${clean(profile.employmentStatus, 40)}; profile status ${clean(profile.profileStatus, 40)}${profile.profileIsLocked ? ' (locked — ask HR for edit access from My Employee Profile)' : ''}.`);
  }
  if (leave) {
    if (leave.balances.length) {
      lines.push(`Leave balance (remaining of yearly entitlement): ${leave.balances.map((b) => `${clean(b.type, 40)} ${b.remaining} of ${b.entitlement} (taken ${b.taken})`).join('; ')}.`);
    } else {
      lines.push('Leave balance: no balance rows on record yet.');
    }
    lines.push(`Your pending leave requests: ${leave.pendingCount}.`);
    leave.recentRequests.slice(0, rich ? 5 : 3).forEach((r) => {
      lines.push(`  Leave request: ${clean(r.type, 40)} ${r.from} to ${r.to} (${r.days} day${r.days === 1 ? '' : 's'}) — ${clean(r.status, 30)}${r.decision ? ` — note: ${clean(r.decision, 80)}` : ''}.`);
    });
  }
  if (attendance) {
    const by = Object.entries(attendance.byStatus || {}).map(([k, v]) => `${clean(k, 30)} ${v}`).join(', ');
    lines.push(`Attendance for ${attendance.month}: ${attendance.markedDays} marked day(s)${by ? ` — ${by}` : ''}.`);
    (attendance.recent || []).slice(0, rich ? 5 : 2).forEach((r) => {
      lines.push(`  ${r.date}: ${clean(r.status, 30)}${r.checkIn ? `, in ${r.checkIn}` : ''}${r.checkOut ? `, out ${r.checkOut}` : ''}.`);
    });
  }
  if (tasks) {
    lines.push(`Open tasks assigned to you: ${tasks.count}${tasks.overdue ? ` (${tasks.overdue} overdue)` : ''}.`);
    tasks.tasks.slice(0, rich ? 5 : 3).forEach((t) => {
      lines.push(`  Task "${clean(t.name, 80)}" — ${clean(t.status, 30)}${t.endDate ? `, due ${String(t.endDate).slice(0, 10)}` : ''}${t.overdue ? ' (overdue)' : ''}.`);
    });
  }
  return lines.length ? { title: 'YOUR HR RECORD', lines } : null;
}

async function sectionHrOrg(user, rich) {
  const today = localDate();
  const weekOut = localDate(new Date(Date.now() + 6 * 86400000));
  const [pending, headcount, onLeave, present] = await Promise.all([
    read(user, 'hr_pending_approvals'),
    read(user, 'headcount_summary', {}),
    read(user, 'who_is_on_leave', { from: today, to: weekOut, status: 'Approved' }),
    read(user, 'attendance_on_date', { date: today }),
  ]);
  const lines = [];
  // headcount_summary answers for an Employee too — with their own single
  // row. It is only an ORG fact when the scope is wider than themselves.
  if (headcount && headcount.total > 1) {
    lines.push(`Headcount you can see (${clean(scopeLabel(user), 80)}): ${headcount.total} — by status: ${headcount.byStatus.map((x) => `${clean(x.name, 30)} ${x.count}`).join(', ')}.`);
    lines.push(`  By department: ${headcount.byDepartment.slice(0, rich ? 12 : 6).map((x) => `${clean(x.name, 40)} ${x.count}`).join(', ')}.`);
  }
  if (pending && headcount && headcount.total > 1) {
    const t = pending.totals || {};
    lines.push(`Waiting on the HR desk in your scope: ${t.leave || 0} pending leave request(s), ${t.profiles || 0} profile(s) awaiting review, ${t.editAccess || 0} edit-access request(s).`);
    (pending.leaveAwaitingDecision || []).slice(0, rich ? 6 : 3).forEach((r) => {
      lines.push(`  Pending leave: ${clean(r.name, 60)} — ${clean(r.type, 40)} ${r.fromDate} to ${r.toDate} (${r.days} day(s)).`);
    });
  }
  if (onLeave && headcount && headcount.total > 1) {
    lines.push(`Approved leave overlapping ${today} to ${weekOut}: ${onLeave.total}${onLeave.total ? ` — ${onLeave.requests.slice(0, rich ? 8 : 4).map((r) => `${clean(r.name, 50)} (${clean(r.type, 30)} ${r.fromDate}–${r.toDate})`).join('; ')}` : ''}.`);
  }
  if (present && present.employeesInScope > 1) {
    const by = Object.entries(present.counts || {}).map(([k, v]) => `${clean(k, 30)} ${v}`).join(', ');
    lines.push(`Attendance today (${present.date}): ${present.recorded} of ${present.employeesInScope} marked${by ? ` — ${by}` : ''}; ${present.noRecord} with no record yet.`);
  }
  return lines.length ? { title: 'PEOPLE IN YOUR SCOPE (HRMS)', lines } : null;
}

async function sectionPolicies(user, rich) {
  const today = localDate();
  const departments = scopeDepartments(user);
  const [types, holidays, cfg, announcements] = await Promise.all([
    prisma.leaveType.findMany({ where: { active: true }, orderBy: { name: 'asc' } }).catch(() => []),
    prisma.holiday.findMany({ where: { date: { gte: today } }, orderBy: { date: 'asc' }, take: rich ? 6 : 3 }).catch(() => []),
    prisma.hrConfig.findFirst().catch(() => null),
    // The SAME audience rule as routes/announcements.js GET.
    prisma.announcement.findMany({
      where: departments === undefined ? {} : {
        OR: [
          { target: null }, { target: '' }, { target: { contains: 'All' } },
          ...departments.map((d) => ({ target: { contains: d } })),
        ],
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: rich ? 3 : 2,
    }).catch(() => []),
  ]);
  const lines = [];
  if (types.length) {
    const unit = (t) => (t.unit === 'month' ? `${t.cap}/month` : t.unit === 'unpaid' ? 'unpaid' : `${t.cap}/year`);
    lines.push(`Leave types: ${types.map((t) => `${clean(t.name, 40)} (${unit(t)}${t.carries ? ', carries forward' : ''})`).join('; ')}.`);
  }
  if (holidays.length) {
    lines.push(`Upcoming holidays: ${holidays.map((h) => `${h.date} ${clean(h.name, 50)}${h.type ? ` (${clean(h.type, 20)})` : ''}`).join('; ')}.`);
  } else {
    lines.push('Upcoming holidays: none on record.');
  }
  if (cfg) {
    lines.push(`Attendance policy: a check-in after ${cfg.graceTime} counts as late; ${cfg.freeLateArrivalsPerMonth} late arrival(s) a month are free; a full day is ${cfg.fullDayHours}h and a half day ${cfg.halfDayHours}h; notice period ${cfg.noticePeriodDays} days.`);
  }
  announcements.forEach((a) => {
    lines.push(`Announcement (${a.date}, ${clean(a.category || 'General', 20)}): "${clean(a.title, 80)}" — ${clean(a.body, 140)}`);
  });
  return lines.length ? { title: 'COMPANY POLICIES AND NOTICES', lines } : null;
}

async function sectionAts(user, rich) {
  if (!(user.products && user.products.ats)) return null;
  const [queue, interviews, offers, liveReqs] = await Promise.all([
    read(user, 'my_pending_actions'),
    read(user, 'upcoming_interviews', { days: 7 }),
    read(user, 'recent_joinings', { openOffersOnly: true }),
    (async () => {
      if (!await can(user, 'ats', 'requirements', 'Requirement List', 'view')) return null;
      return prisma.requirement.count({
        where: { AND: [requirementWhere(user), { status: { in: REQUIREMENT_LIVE_STATUSES } }] },
      });
    })().catch(() => null),
  ]);
  const lines = [];
  if (liveReqs != null) lines.push(`Live requirements you can see: ${liveReqs}.`);
  if (queue) {
    const by = Object.entries(queue.byStage || {}).sort((a, b) => b[1] - a[1]).slice(0, rich ? 10 : 5)
      .map(([k, v]) => `${clean(k, 40)} ${v}`).join(', ');
    lines.push(`Open applications among the 200 most recently updated in your scope: ${queue.totalOpen} (${queue.overdue} past their stage SLA)${by ? ` — by stage: ${by}` : ''}.`);
    queue.items.slice(0, rich ? 8 : 3).forEach((r) => {
      lines.push(`  ${clean(r.candidate, 60)} — ${clean(r.requirement, 60)}${r.client ? ` (${clean(r.client, 40)})` : ''} — ${clean(r.stageLabel, 30)} — next: ${clean(r.nextAction, 60)}${r.due ? `, due ${r.due}` : ''}${r.overdue ? ' (overdue)' : ''}.`);
    });
  }
  if (interviews) {
    lines.push(`Interviews in the next 7 days: ${interviews.count}.`);
    interviews.interviews.slice(0, rich ? 6 : 3).forEach((i) => {
      lines.push(`  ${i.at ? new Date(i.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'time not set'} — ${clean(i.candidate, 60)} for ${clean(i.requirement, 60)}${i.client ? ` (${clean(i.client, 40)})` : ''}${i.mode ? `, ${clean(i.mode, 20)}` : ''}.`);
    });
  }
  if (offers) {
    lines.push(`Offers released and still open: ${offers.count}.`);
    offers.rows.slice(0, rich ? 5 : 2).forEach((o) => {
      lines.push(`  ${clean(o.candidate, 60)} — ${clean(o.requirement, 60)}${o.joiningDate ? `, joining ${o.joiningDate}` : ''}.`);
    });
  }
  return lines.length ? { title: 'RECRUITMENT (ATS) IN YOUR SCOPE', lines } : null;
}

async function sectionAccounts(user, rich) {
  if (!(user.products && user.products.accounts)) return null;
  const [summary, overdue] = await Promise.all([
    read(user, 'accounts_summary'),
    read(user, 'search_invoices', { overdueOnly: true }),
  ]);
  const lines = [];
  if (summary) {
    const a = summary.ageingOfOutstanding || {};
    lines.push(`Invoices you can see: ${summary.invoiceCount}; invoiced ${money(summary.invoiced)}; received ${money(summary.received)}; outstanding ${money(summary.outstanding)}; of which overdue ${money(summary.overdue)} (amounts in the app's currency, INR).`);
    lines.push(`  Outstanding ageing: not yet due ${money(a.notYetDue)}; 1-30 days ${money(a['1-30 days'])}; 31-60 days ${money(a['31-60 days'])}; over 60 days ${money(a['over 60 days'])}.`);
  }
  if (overdue) {
    lines.push(`Overdue invoices: ${overdue.count}.`);
    overdue.invoices
      .sort((x, y) => y.daysOverdue - x.daysOverdue)
      .slice(0, rich ? 6 : 3)
      .forEach((i) => {
        lines.push(`  ${clean(i.invoiceNumber || 'no number', 30)} — ${clean(i.client || 'no client', 50)} — outstanding ${money(i.outstanding)} — ${i.daysOverdue} days overdue.`);
      });
  }
  return lines.length ? { title: 'ACCOUNTS IN YOUR SCOPE', lines } : null;
}

// --- Assembly --------------------------------------------------------------

const ORDER = {
  ats: ['ats', 'myHr', 'policies', 'hrOrg', 'accounts'],
  hrms: ['myHr', 'hrOrg', 'policies', 'ats', 'accounts'],
  accounts: ['accounts', 'myHr', 'policies', 'hrOrg', 'ats'],
  // The main dashboard: the company overview first, then the user's own.
  home: ['hrOrg', 'ats', 'accounts', 'myHr', 'policies'],
  other: ['myHr', 'hrOrg', 'ats', 'accounts', 'policies'],
};

// Which product each section's facts belong to.
const SECTION_PRODUCT = {
  myHr: 'hrms', hrOrg: 'hrms', policies: 'hrms', ats: 'ats', accounts: 'accounts',
};

const SECTIONS = {
  myHr: sectionMyHr,
  hrOrg: sectionHrOrg,
  policies: sectionPolicies,
  ats: sectionAts,
  accounts: sectionAccounts,
};

function roleLine(user) {
  const parts = [];
  if (user.products && user.products.hrms && user.hrmsRole) parts.push(`HRMS role ${atsRoleLabel(user.hrmsRole)}`);
  if (user.products && user.products.ats && user.atsRole) parts.push(`ATS role ${atsRoleLabel(user.atsRole)}`);
  if (user.products && user.products.accounts && user.accountsRole) parts.push(`Accounts role ${atsRoleLabel(user.accountsRole)}`);
  return parts.length ? parts.join(', ') : atsRoleLabel(user.role);
}

// The whole block, markers included. The QUESTION's area orders the sections
// (its facts first and in full); the page decides only when the question
// does not say.
async function buildFacts(user, page, { maxChars = DEFAULT_MAX_FACTS_CHARS, question = '' } = {}) {
  const MAX_FACTS_CHARS = maxChars;
  const area = topicOf(question) || areaOf(page);
  // The AI grant (Role Catalog → AI Assistant & Agent, via req.user.ai)
  // decides which products' sections exist at all; each section's reads
  // still run the user's own can() + scope underneath.
  const aiData = user.ai && user.ai.data;
  const allowedKey = (key) => !aiData || !!aiData[SECTION_PRODUCT[key]];
  const order = (ORDER[area] || ORDER.other).filter(allowedKey);
  // The page's own area is "rich"; on the main dashboard the overview is.
  const richKey = { ats: 'ats', hrms: 'myHr', accounts: 'accounts', home: 'hrOrg', other: 'myHr' }[area];
  const built = await Promise.all(order.map((key) => (
    SECTIONS[key](user, key === richKey || (area === 'hrms' && key === 'hrOrg')).catch(() => null)
  )));

  const now = new Date();
  const head = [
    '===== FACTS =====',
    `Today: ${weekday(now)} ${localDate(now)}.`,
    `User: ${clean(user.name || user.email, 80)} — ${roleLine(user)}. Data scope: ${clean(scopeLabel(user), 100)}.`,
    `Products this login has: ${['hrms', 'ats', 'accounts'].filter((p) => user.products && user.products[p]).map((p) => p.toUpperCase()).join(', ') || 'none'}.`,
  ];
  if (aiData) {
    const off = ['hrms', 'ats', 'accounts'].filter((p) => !aiData[p]).map((p) => p.toUpperCase());
    if (off.length) head.push(`The AI Assistant may NOT answer about ${off.join(', ')} for this user (their role does not allow it): if asked, say so plainly and name the screen or their Super Admin.`);
  }
  let text = head.join('\n');
  let dropped = false;
  built.filter(Boolean).forEach((section) => {
    if (dropped) return;
    const block = [`\n[${section.title}]`, ...section.lines].join('\n');
    if (text.length + block.length > MAX_FACTS_CHARS) {
      // Keep as many whole lines of this section as fit, then stop.
      const room = MAX_FACTS_CHARS - text.length;
      const lines = [`\n[${section.title}]`];
      let used = lines[0].length;
      section.lines.some((l) => {
        if (used + l.length + 1 > room) return true;
        lines.push(l);
        used += l.length + 1;
        return false;
      });
      if (lines.length > 1) text += lines.join('\n');
      dropped = true;
      return;
    }
    text += block;
  });
  if (dropped) text += '\n(Some less relevant facts were left out for length.)';
  text += '\n===== END OF FACTS =====';
  return { text, area };
}

module.exports = { buildFacts, areaOf, topicOf, localDate, weekday, clean };
