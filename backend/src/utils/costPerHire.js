// ---------------------------------------------------------------------------
// COST PER HIRE (ATS-100 B9.3) — ATS Reports → "Cost per hire" tab.
//
//   cost = campaign costs (B6: Campaign costs, campus-drive cost, approved
//          referral bonuses)
//        + partner payouts (B7: utils/partnerPayouts.js when it exists, else 0)
//        + recruiter incentives (utils/recruiterJoinings.js countedPlacements:
//          the month's INCENTIVE decision per recruiter)
//   cost per hire = cost ÷ joinings (the same COUNTED joinings as the
//          Recruiter joinings board)
//
// by month / by department / by recruiter. A cost is attributed through the
// joining it produced: a campaign's cost is spread equally over its joinings
// in the period (a campaign with none goes to "Not linked to a joining" for
// its month), a referral bonus to its own joining's recruiter, an incentive
// to its recruiter. Every joining figure opens its people.
//
// Money is shown to Super Admin / Admin / HR / Manager / Assistant Manager /
// Accountant (the same rule as the Campaigns tab); others see joinings only.
//
// Partner payouts contract (B7): utils/partnerPayouts.js may export
//   costPerHireRows({ from, to }) -> [{ month: 'YYYY-MM', amount, applicationId?, recruiterUserId?, department? }]
// Until it does, partner payouts are 0 and the tile says so.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const dateRange = require('./dateRange');
const RJ = require('./recruiterJoinings');

const COST_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'ASSISTANT_MANAGER', 'ACCOUNTANT'];
const held = (u) => {
  const sr = (u && u.scopeRoles) || {};
  return [u && u.role, u && u.atsRole, u && u.hrmsRole, u && u.accountsRole, sr.ats, sr.hrms, sr.accounts].filter(Boolean);
};
const R = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (mk) => (/^\d{4}-\d{2}$/.test(mk) ? `${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(0, 4)}` : mk);
const monthOf = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null; };
const NO_JOIN = 'Not linked to a joining';

function monthsOf(p) {
  const out = [];
  let [y, m] = p.from.slice(0, 7).split('-').map(Number);
  const end = p.to.slice(0, 7);
  for (let i = 0; i < 24; i += 1) {
    const mk = `${y}-${String(m).padStart(2, '0')}`;
    out.push(mk);
    if (mk >= end) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

module.exports = function costPerHire({ Cell, section, addTotal, tileSet }) {
  async function prepare(ctx, user) {
    const P = ctx.f.period || dateRange.resolve({ range: 'this_month' });
    const months = monthsOf(P);
    const key = months.join(',');
    ctx.cph = ctx.cph || {};
    if (ctx.cph.key === key) return;
    const boards = await Promise.all(months.map((mk) => RJ.countedPlacements(mk).catch(() => [])));
    const joined = []; // { appId, month, userId, employeeId, name, department, incentive share }
    const incentives = []; // { month, userId, name, department, amount }
    boards.forEach((rows, i) => rows.forEach((r) => {
      if (r.incentive) incentives.push({ month: months[i], userId: r.userId, employeeId: r.employeeId, name: r.name, department: r.department || null, amount: Number(r.incentive) || 0 });
      r.applicationIds.forEach((id) => joined.push({ appId: id, month: months[i], userId: r.userId, employeeId: r.employeeId, name: r.name, department: r.department || null }));
    }));
    const appIds = [...new Set(joined.map((j) => j.appId))];
    const apps = appIds.length ? await prisma.application.findMany({
      where: { id: { in: appIds } },
      select: {
        id: true, utmCampaign: true, campusDriveId: true, referralId: true,
        requirement: { select: { clientId: true, department: true, client: { select: { name: true } } } },
      },
    }) : [];
    const appOf = new Map(apps.map((a) => [a.id, a]));
    const [campaigns, drives, referrals] = await Promise.all([
      prisma.sourcingCampaign.findMany().catch(() => []),
      prisma.campusDrive.findMany().catch(() => []),
      prisma.candidateReferral.findMany({ where: { bonusStatus: 'APPROVED', applicationId: { not: null } } }).catch(() => []),
    ]);
    let partner = [];
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const PP = require('./partnerPayouts');
      if (PP && typeof PP.costPerHireRows === 'function') partner = (await PP.costPerHireRows({ from: P.from, to: P.to })) || [];
      ctx.cph.partnerReady = !!(PP && typeof PP.costPerHireRows === 'function');
    } catch { ctx.cph.partnerReady = false; }
    ctx.cph = { ...ctx.cph, key, P, months, joined, incentives, appOf, campaigns, drives, referrals, partner, showCost: held(user).some((r) => COST_ROLES.includes(r)) };
  }

  function build(ctx) {
    const c = ctx.cph || { months: [], joined: [], incentives: [], appOf: new Map(), campaigns: [], drives: [], referrals: [], partner: [] };
    const f = ctx.f || {};
    const showCost = !!c.showCost;
    const months = new Set(c.months);
    // The person filter (u:<userId> / n:<name>), the department and the client.
    const personOk = (j) => {
      if (!f.recruiter) return true;
      if (f.recruiter.startsWith('u:')) return j.userId === f.recruiter.slice(2);
      if (f.recruiter.startsWith('n:')) return String(j.name || '').toLowerCase() === f.recruiter.slice(2);
      return true;
    };
    const deptOk = (d) => !f.department || d === f.department;
    const joined = c.joined.filter((j) => personOk(j) && deptOk(j.department)
      && (!f.clientId || ((c.appOf.get(j.appId) || {}).requirement || {}).clientId === f.clientId));
    const joinedIds = new Set(joined.map((j) => j.appId));

    // Costs, each attributed to (month, department, recruiter, appIds).
    const costs = []; // { kind: 'campaign'|'partner'|'incentive', month, department, person, name, amount, appId? }
    const byTag = (get) => {
      const m = new Map();
      joined.forEach((j) => { const t = get(c.appOf.get(j.appId) || {}); if (t) m.set(t, [...(m.get(t) || []), j]); });
      return m;
    };
    const campJoins = byTag((a) => (a.utmCampaign ? String(a.utmCampaign).toLowerCase() : null));
    const driveJoins = byTag((a) => a.campusDriveId || null);
    const spread = (kind, amount, mk, list, name) => {
      if (!(amount > 0)) return;
      if (list && list.length) {
        const share = amount / list.length;
        list.forEach((j) => costs.push({ kind, month: j.month, department: j.department, person: j.userId || j.name, name: j.name, amount: share, appId: j.appId, label: name }));
      } else if (months.has(mk)) {
        costs.push({ kind, month: mk, department: NO_JOIN, person: NO_JOIN, name: NO_JOIN, amount, appId: null, label: name });
      }
    };
    c.campaigns.forEach((x) => spread('campaign', Number(x.cost) || 0, monthOf(x.startDate) || monthOf(x.createdAt), campJoins.get(String(x.key || '').toLowerCase()), x.name));
    c.drives.forEach((x) => spread('campaign', Number(x.cost) || 0, monthOf(x.driveDate), driveJoins.get(x.id), x.name));
    c.referrals.forEach((x) => {
      const j = joined.find((y) => y.appId === x.applicationId);
      spread('campaign', Number(x.bonusAmount) || 0, j ? j.month : monthOf(x.bonusDecidedAt), j ? [j] : null, 'Referral bonus');
    });
    c.incentives.filter((x) => personOk(x) && deptOk(x.department)).forEach((x) => {
      if (f.clientId) return; // an incentive is per month, not per client — left out when a client is picked
      costs.push({ kind: 'incentive', month: x.month, department: x.department, person: x.userId || x.name, name: x.name, amount: x.amount, appId: null, label: 'Incentive' });
    });
    (c.partner || []).forEach((x) => {
      const j = x.applicationId ? joined.find((y) => y.appId === x.applicationId) : null;
      if (x.applicationId && !j) return; // outside the filters
      const mk = j ? j.month : monthOf(x.month);
      if (!months.has(mk)) return;
      costs.push({ kind: 'partner', month: mk, department: j ? j.department : (x.department || NO_JOIN), person: j ? (j.userId || j.name) : (x.recruiterUserId || NO_JOIN), name: j ? j.name : NO_JOIN, amount: Number(x.amount) || 0, appId: j ? j.appId : null, label: 'Partner payout' });
    });

    const sum = (list, kind) => R(list.filter((x) => !kind || x.kind === kind).reduce((s, x) => s + x.amount, 0));
    const total = sum(costs);
    const t = tileSet();
    const tj = t.add('joinings', 'Joinings', 'app', 'counted placements in the period');
    joined.forEach((j) => tj.add(j.appId));
    if (showCost) {
      t.value('cost', 'Total cost', total, 'campaigns + partner payouts + incentives', 'money');
      t.value('cph', 'Cost per hire', joinedIds.size ? R(total / joinedIds.size) : null, 'total cost ÷ joinings', 'money');
      t.value('campaign', 'Campaign costs', sum(costs, 'campaign'), 'campaigns, campus drives, referral bonuses', 'money');
      t.value('incentive', 'Recruiter incentives', sum(costs, 'incentive'), 'Monthly incentive decisions', 'money');
      t.value('partner', 'Partner payouts', sum(costs, 'partner'), c.partnerReady ? 'paid to partners / freelancers' : 'built, waits for the Partners module (0 for now)', 'money');
    }

    const cols = (first) => [
      first,
      { key: 'joinings', label: 'Joinings', drill: 'app' },
      ...(showCost ? [
        { key: 'campaign', label: 'Campaign costs ₹', type: 'money' },
        { key: 'partner', label: 'Partner payouts ₹', type: 'money' },
        { key: 'incentive', label: 'Incentives ₹', type: 'money' },
        { key: 'total', label: 'Total cost ₹', type: 'money' },
        { key: 'cph', label: 'Cost per hire ₹', type: 'money' },
      ] : []),
    ];
    const derive = (cells) => {
      if (!showCost) return;
      cells.total = R((cells.campaign || 0) + (cells.partner || 0) + (cells.incentive || 0));
      cells.cph = cells.joinings && cells.joinings.n ? R(cells.total / cells.joinings.n) : null;
    };
    const fill = (sec, keyOf, labelOf, order) => {
      const rowOf = (k, label) => {
        const r = sec.row(k);
        const first = sec.columns[0].key;
        if (!r.cells[first]) r.cells[first] = label;
        if (showCost) { r.cells.campaign = r.cells.campaign || 0; r.cells.partner = r.cells.partner || 0; r.cells.incentive = r.cells.incentive || 0; }
        return r;
      };
      joined.forEach((j) => rowOf(keyOf(j), labelOf(j)).cells.joinings.add(j.appId));
      if (showCost) {
        costs.forEach((x) => { const r = rowOf(keyOf(x), labelOf(x)); r.cells[x.kind] = R(r.cells[x.kind] + x.amount); });
      }
      sec.rows.forEach((r) => derive(r.cells));
      sec.sort = order;
      addTotal(sec, derive);
    };
    const byMonth = section('months', 'Cost per hire by month', cols({ key: 'month', label: 'Month' }), { sub: 'Joinings as the Recruiter joinings board counts them. Costs sit in the month of the joining they produced; a campaign with no joining yet sits in its own month.' });
    fill(byMonth, (x) => x.month, (x) => monthLabel(x.month), (a, b) => String(a.key).localeCompare(String(b.key)));
    const byDept = section('departments', 'Cost per hire by department', cols({ key: 'department', label: 'Department' }), { sub: 'The recruiter\'s department at the time of the joining.' });
    fill(byDept, (x) => x.department || '—', (x) => x.department || '—', (a, b) => (b.cells.joinings.n - a.cells.joinings.n));
    const byRec = section('recruiters', 'Cost per hire by recruiter', cols({ key: 'recruiter', label: 'Recruiter' }), { sub: 'Incentives are the Monthly incentive decision; campaign costs are spread over the joinings the campaign produced.', paged: true });
    fill(byRec, (x) => x.person || x.name || '—', (x) => x.name || '—', (a, b) => (b.cells.joinings.n - a.cells.joinings.n));

    const notes = [];
    if (!showCost) notes.push('Cost figures are for Super Admin, Admin, HR, Manager and Accounts. You see the joinings only.');
    if (showCost && !c.partnerReady) notes.push('Partner payouts: the Partners module (B7) is not live yet, so this column is 0 for now.');
    if (f.clientId && showCost) notes.push('A client is picked: recruiter incentives are per month, not per client, so they are left out here.');
    if (!joined.length) notes.push('No counted joinings in this period for these filters.');
    return {
      tiles: t.tiles, sections: [byMonth, byDept, byRec], notes, plain: true,
      period: c.P ? { key: c.P.key, label: c.P.label, from: c.P.from, to: c.P.to } : undefined,
    };
  }

  return { prepare, build };
};
