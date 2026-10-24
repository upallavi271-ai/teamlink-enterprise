// ---------------------------------------------------------------------------
// OMNI-CHANNEL DASHBOARD (founder structure plan 2026-10-17): ONE dashboard, blocks chosen by the login's level (outreach/access.js level()):
//   Recruiter / BDE / HR / Marketing  today's messages, responses, interviews booked, follow-ups, credits used
//   Team Lead                         team activity, campaign performance, recruiter performance
//   Department Head (STL, Manager)    department usage, recruiter ROI, department joinings
//   Super Admin / Admin               company usage, credits, revenue / ROI, every department
// A block is { id, title, tiles: [{ label, value, tone }], head, rows, note } so the screen draws every level with the same component.
// Read only; every number is held to what this login may see (the same scope as Insights).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const A = require('./access');
const Cr = require('./credits');
const Ov = require('./overview');
const Ins = require('./insights');

const dayStartIST = (now = Date.now()) => Math.floor((now + 5.5 * 3600000) / 86400000) * 86400000 - 5.5 * 3600000;
const t = (label, value, tone) => ({ label, value, tone: tone || '' });
const rupee = (n) => `Rs ${Math.round(n || 0).toLocaleString('en-IN')}`;

async function mine(user, month) {
  const from = dayStartIST();
  const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
  await Cr.ensureTables();
  const today = await q('SELECT mode, COUNT(*) n FROM "OmniCreditLedger" WHERE userId = ? AND at >= ? AND result <> \'failed\' GROUP BY mode', user.id, from);
  const live = Number((today.find((r) => r.mode === 'live') || {}).n || 0); const test = Number((today.find((r) => r.mode === 'test') || {}).n || 0);
  let unread = 0; let repliesToday = 0;
  try { unread = (await require('../utils/conversations').unreadCount(user)).conversations || 0; } catch { unread = 0; } // eslint-disable-line global-require
  try { repliesToday = (await Ins.repliesByOwner([user.id], from, Date.now() + 60000)).get(user.id) || 0; } catch { repliesToday = 0; }
  let interviews = 0;
  try { interviews = await prisma.applicationStageEvent.count({ where: { toStage: 'INTERVIEW_SCHEDULED', actorUserId: user.id, createdAt: { gte: new Date(from) } } }); } catch { interviews = 0; }
  let open = 0; let overdue = 0; let doneToday = 0;
  try {
    const today10 = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    open = await prisma.applicationFollowUp.count({ where: { ownerUserId: user.id, completedAt: null } });
    overdue = await prisma.applicationFollowUp.count({ where: { ownerUserId: user.id, completedAt: null, dueDate: { lt: today10 } } });
    doneToday = await prisma.applicationFollowUp.count({ where: { completedById: user.id, completedAt: { gte: new Date(from) } } });
  } catch { /* follow-ups not reachable */ }
  const st = await Cr.settings(); const p = await Cr.personOf(user.id); const exempt = Cr.isExempt(st, p);
  const used = await Cr.usedBy(user.id, month);
  const allowance = exempt ? null : await Cr.allowanceOf(st, user.id);
  return {
    id: 'mine', title: 'Your day',
    tiles: [t('Messages sent today', live, 'g'), t('Rehearsed today (not real)', test), t('Replies waiting to be read', unread, unread ? 'o' : ''), t('Replies that came in today', repliesToday), t('Interviews you booked today', interviews),
      t('Follow-ups open', open), t('Follow-ups overdue', overdue, overdue ? 'r' : ''), t('Follow-ups you finished today', doneToday, 'g'), t('Credits used this month', used), t('Credits left', exempt ? 'No limit' : Math.max(0, allowance - used))],
  };
}
const teamTable = (rows) => ({ head: ['Name', 'Credits used', 'Messages', 'Follow-ups', 'Promotions', 'Joinings'], rows: rows.slice(0, 15).map((r) => [r.name, r.used, r.sent, r.followUps, r.promotions, r.joinings]) });

async function dashboard(user) {
  const level = A.level(user);
  const month = Cr.thisMonth();
  const overview = await Ov.overview(user).catch(() => ({ ready: false }));
  const blocks = [];
  if (['recruiter', 'bde', 'hr', 'marketing'].includes(level)) blocks.push(await mine(user, month));
  if (level === 'teamlead' || level === 'depthead' || level === 'admin') blocks.push(await mine(user, month));
  if (level === 'teamlead') {
    const p = await Ins.performance(user, month);
    blocks.push({ id: 'team', title: 'Team activity', tiles: [t('People in your team', p.totals.people), t('Credits used', p.totals.used), t('Messages sent', p.totals.sent), t('Follow-ups done', p.totals.followUps), t('Joinings', p.totals.joinings, 'g')] });
    const c = p.campaignTotals || {};
    blocks.push({ id: 'campaigns', title: 'Campaign performance (last 30 days)', tiles: [t('Campaigns', c.campaigns || 0), t('Sent', c.sent || 0), t('Delivered', c.delivered || 0, 'g'), t('Opened the apply link', c.clicked || 0), t('Failed', c.failed || 0, c.failed ? 'r' : '')], ...{ head: ['Campaign', 'Sent', 'Delivered', 'Failed'], rows: (p.topCampaigns || []).map((x) => [x.name, x.sent, x.delivered, x.failed]) } });
    blocks.push({ id: 'recruiters', title: 'Recruiter performance this month', ...teamTable(p.rows) });
  }
  if (level === 'depthead') {
    const p = await Ins.performance(user, month);
    blocks.push({ id: 'dept', title: `Department usage (${p.scopeWords})`, tiles: [t('People', p.totals.people), t('Credits used', p.totals.used), t('Messages sent', p.totals.sent), t('Promotions', p.totals.promotions)], head: ['Department', 'People', 'Credits used', 'Messages'], rows: p.byDepartment.map((d) => [d.name, d.people, d.used, d.sent]) });
    const r = await Ins.roi(user, month);
    blocks.push({ id: 'roi', title: 'Recruiter ROI this month', head: ['Name', 'Credits used', 'Cost', 'Replies', 'Interviews', 'Joinings'], rows: r.persons.slice().sort((a, b) => b.joinings - a.joinings).slice(0, 15).map((x) => [x.name, x.credits, rupee(x.cost), x.replies, x.interviews, x.joinings]), note: r.notes[0] });
    blocks.push({ id: 'joinings', title: 'Department joinings this month', tiles: [t('Joinings', p.totals.joinings, 'g')], head: ['Department', 'Joinings'], rows: p.byDepartment.map((d) => [d.name, d.joinings]) });
  }
  if (level === 'admin') {
    const u = await Ins.usage(month);
    const p = await Ins.performance(user, month);
    blocks.push({ id: 'company', title: 'Company usage this month', tiles: [t('People counted', p.totals.people), t('Messages sent', p.totals.sent), t('Credits used', p.totals.used), t('Rehearsed (not real)', p.totals.testSent), t('Follow-ups done', p.totals.followUps), t('Joinings', p.totals.joinings, 'g')] });
    blocks.push({ id: 'credits', title: 'Credits', tiles: u.balance.filter((b) => b.channel !== 'call').map((b) => t(`${b.channel === 'whatsapp' ? 'WhatsApp' : b.channel === 'sms' ? 'SMS' : 'Email'} credits left`, b.bought ? b.left : 'Not recorded')), note: 'Left = credits added in Insights > Credits minus credits used. Add each recharge there.' });
    let revenue = 0; let received = 0; let invoices = 0;
    try {
      const inv = await prisma.invoice.findMany({ where: { invoiceDate: { startsWith: month }, status: { not: 'Cancelled' } }, select: { amount: true, receivedAmount: true } });
      inv.forEach((x) => { revenue += x.amount || 0; received += x.receivedAmount || 0; }); invoices = inv.length;
    } catch { /* accounts not reachable */ }
    const cost = u.totalCost;
    blocks.push({ id: 'revenue', title: 'Revenue and ROI (company)', tiles: [t('Invoices raised this month', invoices), t('Invoiced', rupee(revenue)), t('Received', rupee(received), 'g'), t('Messaging cost', rupee(cost)), t('Invoiced per rupee of messaging', cost > 0 ? (revenue / cost).toFixed(1) : 'Type unit costs first')], note: 'Revenue is the invoices Accounts raised this month; it is company-wide and is not tied to one campaign. Messaging cost uses the unit costs typed in Configuration (they start at 0).' });
    blocks.push({ id: 'depts', title: 'Every department', head: ['Department', 'People', 'Credits used', 'Messages', 'Joinings'], rows: p.byDepartment.map((d) => [d.name, d.people, d.used, d.sent, d.joinings]) });
  }
  if (level === 'finance') {
    const u = await Ins.usage(month);
    blocks.push({ id: 'finance', title: 'Credits and cost', tiles: [t('Messaging cost this month', rupee(u.totalCost))], head: ['Way', 'Messages', 'Credits', 'Cost'], rows: u.channels.map((c) => [c.channel, c.messages, c.credits, rupee(c.cost)]) });
  }
  return { level, levelWords: A.LEVEL_WORDS[level], month, overview, blocks };
}

module.exports = { dashboard };
