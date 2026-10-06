// ---------------------------------------------------------------------------
// CAMPAIGN PERFORMANCE (b6_, ATS-100 B6.3) — ATS Reports → "Campaigns" tab.
//
//   campaign (utm_campaign) · campus drive · employee referral
//     → applications → screened → interviews → joined
//     + cost (Campaign costs / the drive's cost / approved referral bonuses)
//     + cost per joining
//
// Built from the SAME scoped snapshot as every other ATS report
// (routes/atsReports.js loadContext): each number is a Cell holding the
// application ids behind it, so a click opens exactly those people and the
// export is the same table. Only applications that carry a campaign, a drive
// or a referral are counted here; everything else is in the Source reports.
//
// Cost is shown to Super Admin / Admin / HR / Manager / Assistant Manager /
// Accountant only; other report readers get the funnel without money.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const COST_ROLES = ['SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'ASSISTANT_MANAGER', 'ACCOUNTANT'];
const held = (u) => {
  const sr = (u && u.scopeRoles) || {};
  return [u && u.role, u && u.atsRole, u && u.hrmsRole, u && u.accountsRole, sr.ats, sr.hrms, sr.accounts].filter(Boolean);
};

module.exports = function campaignReport({
  Cell, section, addTotal, tileSet, pct,
}) {
  async function prepare(ctx, user) {
    ctx.campShowCost = held(user).some((r) => COST_ROLES.includes(r));
    const tagged = await prisma.application.findMany({
      where: {
        OR: [
          { utmCampaign: { not: null } }, { utmSource: { not: null } }, { referralId: { not: null } },
          { referredByName: { not: null } }, { campusDriveId: { not: null } },
        ],
      },
      select: {
        id: true, utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true,
        referralId: true, referredByName: true, campusDriveId: true,
      },
    });
    const [costs, drives, referrals] = await Promise.all([
      prisma.sourcingCampaign.findMany(),
      prisma.campusDrive.findMany(),
      prisma.candidateReferral.findMany({
        where: { applicationId: { not: null } },
        select: { id: true, applicationId: true, referrerName: true, referrerUserId: true, bonusAmount: true, bonusStatus: true },
      }),
    ]);
    ctx.camp = {
      tags: new Map(tagged.map((a) => [a.id, a])),
      costs: new Map(costs.map((c) => [c.key, c])),
      drives: new Map(drives.map((d) => [d.id, d])),
      refByApp: new Map(referrals.map((r) => [r.applicationId, r])),
    };
  }

  function build(ctx) {
    const showCost = !!ctx.campShowCost;
    const { tags, costs, drives, refByApp } = ctx.camp || {
      tags: new Map(), costs: new Map(), drives: new Map(), refByApp: new Map(),
    };
    const money = showCost ? [
      { key: 'cost', label: 'Cost', type: 'money' },
      { key: 'cpj', label: 'Cost per joining', type: 'money' },
    ] : [];
    const FUNNEL = [
      { key: 'applied', label: 'Applications', drill: 'app' },
      { key: 'screened', label: 'Screened', drill: 'app' },
      { key: 'interviews', label: 'Interviews', drill: 'app' },
      { key: 'joined', label: 'Joined', drill: 'app' },
      { key: 'toJoin', label: 'Applied → Joined', type: 'pct' },
      ...money,
    ];
    const byCamp = section('campaigns', 'Which campaign brings people who join', [
      { key: 'name', label: 'Campaign' }, { key: 'kind', label: 'Type' }, { key: 'channel', label: 'Source / medium' }, ...FUNNEL,
    ], { sub: 'A campaign is the utm_campaign of the link people applied from. Campus drives and employee referrals are listed too.', paged: true });
    const byReferrer = section('referrers', 'Employee referrals — who refers people who join', [
      { key: 'name', label: 'Referred by' }, ...FUNNEL.filter((c) => !['cost', 'cpj'].includes(c.key)),
      ...(showCost ? [{ key: 'bonus', label: 'Bonus approved', type: 'money' }] : []),
    ], { sub: 'From the "Refer a candidate" form and personal referral links. Bonuses are approved by Super Admin, outside payroll.' });

    const count = (cells, x) => {
      cells.applied.add(x.id);
      if (x.screened) cells.screened.add(x.id);
      if (x.reached('interview') || x.a.interviewAt || x.a.interviewStatus) cells.interviews.add(x.id);
      if (x.joined) cells.joined.add(x.id);
    };
    const bonusOf = new Map(); // row key -> approved bonus total
    ctx.apps.forEach((x) => {
      const t = tags.get(x.id);
      if (!t) return;
      if (t.utmCampaign) {
        const key = `c:${t.utmCampaign.toLowerCase()}`;
        const c = costs.get(t.utmCampaign.toLowerCase());
        const r = byCamp.row(key);
        r.cells.name = (c && c.name) || t.utmCampaign;
        r.cells.kind = 'Campaign';
        if (!r.cells.channel) r.cells.channel = [t.utmSource, t.utmMedium].filter(Boolean).join(' / ') || null;
        count(r.cells, x);
      } else if (t.utmSource && !t.campusDriveId && !t.referralId && !t.referredByName) {
        // A tagged link with no campaign name: grouped by its source.
        const r = byCamp.row(`s:${t.utmSource.toLowerCase()}`);
        r.cells.name = `(no campaign name) ${t.utmSource}`;
        r.cells.kind = 'Campaign';
        r.cells.channel = [t.utmSource, t.utmMedium].filter(Boolean).join(' / ');
        count(r.cells, x);
      }
      if (t.campusDriveId) {
        const d = drives.get(t.campusDriveId);
        const r = byCamp.row(`d:${t.campusDriveId}`);
        r.cells.name = d ? `${d.collegeName} (${d.driveDate})` : 'Campus drive';
        r.cells.kind = 'Campus drive';
        r.cells.channel = 'Campus';
        r.driveId = t.campusDriveId;
        count(r.cells, x);
      }
      if (t.referralId || t.referredByName) {
        const r = byCamp.row('referral');
        r.cells.name = 'Employee referrals';
        r.cells.kind = 'Referral';
        r.cells.channel = 'Referral';
        count(r.cells, x);
        const ref = refByApp.get(x.id);
        const who = (ref && ref.referrerName) || t.referredByName || '—';
        const rr = byReferrer.row(`r:${who.toLowerCase()}`);
        rr.cells.name = who;
        count(rr.cells, x);
        if (ref && ref.bonusStatus === 'APPROVED' && ref.bonusAmount) {
          bonusOf.set('referral', (bonusOf.get('referral') || 0) + ref.bonusAmount);
          bonusOf.set(rr.key, (bonusOf.get(rr.key) || 0) + ref.bonusAmount);
        }
      }
    });
    // A campaign with a cost entered but nobody (yet, or in these filters):
    // shown, so money spent with no result is visible.
    if (showCost) {
      costs.forEach((c, key) => {
        if (c.cost == null) return;
        const r = byCamp.row(`c:${key}`);
        if (!r.cells.name) { r.cells.name = c.name; r.cells.kind = 'Campaign'; r.cells.channel = [c.source, c.medium].filter(Boolean).join(' / ') || null; }
      });
    }

    const derive = (cells) => { cells.toJoin = pct(cells.joined.n, cells.applied.n); };
    let totalCost = 0;
    let anyCost = false;
    byCamp.rows.forEach((r) => {
      derive(r.cells);
      if (!showCost) return;
      let cost = null;
      if (r.key.startsWith('c:')) { const c = costs.get(r.key.slice(2)); cost = c && c.cost != null ? c.cost : null; }
      if (r.key.startsWith('d:')) { const d = drives.get(r.key.slice(2)); cost = d && d.cost != null ? d.cost : null; }
      if (r.key === 'referral') cost = bonusOf.get('referral') || null;
      r.cells.cost = cost;
      r.cells.cpj = cost != null && r.cells.joined.n ? Math.round(cost / r.cells.joined.n) : null;
      if (cost != null) { totalCost += cost; anyCost = true; }
    });
    byReferrer.rows.forEach((r) => {
      derive(r.cells);
      if (showCost) r.cells.bonus = bonusOf.get(r.key) || null;
    });
    byCamp.sort = (a, b) => b.cells.joined.n - a.cells.joined.n || b.cells.applied.n - a.cells.applied.n;
    byReferrer.sort = byCamp.sort;
    addTotal(byCamp, derive);
    addTotal(byReferrer, derive);
    if (showCost) {
      byCamp.total.cells.cost = anyCost ? totalCost : null;
      byCamp.total.cells.cpj = anyCost && byCamp.total.cells.joined.n ? Math.round(totalCost / byCamp.total.cells.joined.n) : null;
      const bt = [...byReferrer.rows.values()].reduce((s, r) => s + (r.cells.bonus || 0), 0);
      byReferrer.total.cells.bonus = bt || null;
    }

    const tot = byCamp.total.cells;
    const t = tileSet();
    t.push('applied', 'Applications from campaigns', tot.applied, 'Campaign links, campus drives and referrals');
    t.push('interviews', 'Interviews', tot.interviews);
    t.push('joined', 'Joined', tot.joined);
    if (showCost) {
      t.value('cost', 'Money spent', anyCost ? totalCost : null, 'Campaign costs + drive costs + approved referral bonuses', 'money');
      t.value('cpj', 'Cost per joining', tot.cpj, 'Money spent ÷ people who joined', 'money');
    }
    const notes = [];
    if (!tot.applied.n) notes.push('No application has a campaign, campus drive or referral yet. Add ?utm_campaign=<name> to the job links you share, or refer people from My profile → Refer a candidate.');
    const best = [...byCamp.rows.values()].filter((r) => r.cells.joined.n && r.cells.cpj != null).sort((a, b) => a.cells.cpj - b.cells.cpj)[0];
    if (best) notes.push(`Cheapest per joining: ${best.cells.name} — ₹${best.cells.cpj.toLocaleString('en-IN')} per person who joined.`);
    return { tiles: t.tiles, sections: [byCamp, byReferrer], notes, plain: true };
  }

  return { prepare, build, Cell };
};
