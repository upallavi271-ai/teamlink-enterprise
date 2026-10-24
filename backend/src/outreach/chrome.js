// ---------------------------------------------------------------------------
// OMNI-CHANNEL PAGE CHROME (the prototype's top bar and sidebar numbers), all read only:
//   wallet(user)      the credits pill: a person sees THEIR credits left this month ("No limit" for exempt logins); an Admin / Finance login sees the company
//                     (credits bought minus used when recharges are recorded in Billing, otherwise credits used this month).
//   workspaces(user)  the workspace (= department) switcher: Admin / Manager (all departments) see every department, everybody else only their own.
//   badges(user)      the numbers on the sidebar: unread replies (WhatsApp inbox) and campaigns waiting for approval.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const Cr = require('./credits');

async function wallet(user) {
  const month = Cr.thisMonth();
  const lvl = A.level(user);
  try {
    await Cr.ensureTables();
    const st = await Cr.settings();
    if (lvl === 'admin' || lvl === 'finance') {
      const Ins = require('./insights'); // eslint-disable-line global-require
      const u = await Ins.usage(month);
      const bought = u.balance.reduce((n, b) => n + (b.channel === 'call' ? 0 : b.bought), 0);
      const used = u.balance.reduce((n, b) => n + (b.channel === 'call' ? 0 : b.used), 0);
      const thisMonthUsed = u.channels.reduce((n, c) => n + c.credits, 0);
      if (bought > 0) return { mode: 'company', month, value: Math.max(0, bought - used), label: 'credits left (company)', words: 'Company credits: bought minus used. Add recharges in Billing.', exempt: false };
      return { mode: 'company', month, value: thisMonthUsed, label: 'credits used this month (company)', words: 'No recharge is recorded yet, so this shows what the company used this month.', exempt: false, noRecharge: true };
    }
    const p = await Cr.personOf(user.id);
    const exempt = Cr.isExempt(st, p);
    const used = await Cr.usedBy(user.id, month);
    if (exempt) return { mode: 'person', month, value: null, used, label: 'No limit', words: 'Your login has no monthly limit.', exempt: true };
    const allowance = await Cr.allowanceOf(st, user.id);
    return { mode: 'person', month, value: Math.max(0, allowance - used), allowance, used, label: 'credits left this month', words: `You were given ${allowance} credits this month and used ${used}.`, exempt: false };
  } catch (e) { return { mode: 'person', month, value: null, label: 'credits', words: 'The credits could not be read.', error: true }; }
}

async function workspaces(user) {
  const sc = A.deptScope(user);
  let names = [];
  if (sc.all) {
    const master = (await prisma.department.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }).catch(() => [])).map((d) => d.name);
    let extra = [];
    try { extra = (await require('./config').departments()).rows.map((r) => r.name); } catch { extra = []; } // eslint-disable-line global-require
    names = [...new Set([...master, ...extra])];
  } else {
    // the person's own department(s), spelled as the Department master spells them
    const master = (await prisma.department.findMany({ where: { active: true }, select: { name: true } }).catch(() => [])).map((d) => d.name);
    names = sc.departments.map((d) => master.find((m) => m.toLowerCase() === d) || d.replace(/^./, (c) => c.toUpperCase()));
  }
  let people = {};
  try {
    const emps = await prisma.employee.groupBy({ by: ['department'], where: { employmentStatus: 'Active', department: { not: null } }, _count: { _all: true } });
    emps.forEach((e) => { people[String(e.department).toLowerCase()] = e._count._all; });
  } catch { people = {}; }
  return { all: sc.all, canSwitch: sc.all || names.length > 1, list: names.map((name) => ({ name, people: people[name.toLowerCase()] || 0 })), company: 'TeamLink' };
}

async function badges(user) {
  let unread = 0; let approvals = 0; let review = 0;
  try { unread = (await require('../utils/conversations').unreadCount(user)).conversations || 0; } catch { unread = 0; } // eslint-disable-line global-require
  try { if (A.has('mayApprove')(user)) approvals = await require('./approval').pendingCount(user); } catch { approvals = 0; } // eslint-disable-line global-require
  try { review = await require('./omni/replyRouter').reviewCount(user); } catch { review = 0; } // eslint-disable-line global-require
  return { inboxUnread: unread, approvals, review };
}

// the departments a request may filter by: '' (all) for everybody; a named one only when this login may see it
function deptOf(user, wanted) {
  const d = String(wanted || '').trim();
  if (!d) return '';
  return A.mayDepartment(user, d) ? d : null; // null = not allowed
}

module.exports = { wallet, workspaces, badges, deptOf };
