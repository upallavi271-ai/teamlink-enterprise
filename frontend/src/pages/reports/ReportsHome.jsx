import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import { useReportCatalog } from './ReportBits.jsx';

// ---------------------------------------------------------------------------
// REPORTS — the landing page (section 17, 2026-10-03): ONE list of report
// cards, each with the one question it answers, so anyone picks the right one
// in five seconds. A card opens its report on this same page (?tab=<id>);
// a card with several views shows them as a small switch inside the report.
//
// Which cards show is the SERVER's answer (GET /api/ats-reports/catalog):
// Client revenue only for Super Admin / Admin / Accounts, and the server
// refuses it to everyone else anyway.
//
// A report tab another screen adds to ATS_REPORT_TABS without a card here
// still gets one, under "More".
// ---------------------------------------------------------------------------
// ONE CARD PER REPORT, IN SIX PLAIN GROUPS (founder 2026-11-04: "reports & team module lo antha, chaala messy ga, clumsy ga
// vundhi ... ey role vallaki reports lo em vundalo, clear ga chusi modify cheyyu"). Before, the same report sat on two or three
// cards under different names and every login saw every card - even the ones the server then refused. Now each report has one
// card and one name, a card's views are the closely related reports, and a login sees only the cards (and the views) its role
// opens: GET /api/ats-reports/catalog -> reports (routes/atsReports.js). Nothing was removed: every report is still here.
export const REPORT_GROUPS = [
  {
    id: 'progress',
    title: 'Hiring progress',
    cards: [
      { id: 'funnel', icon: '🔻', title: 'Hiring funnel', answers: 'How many people go from applied to joined, by step and by department?', views: [['funnel', 'Steps'], ['departments', 'By department']] },
      { id: 'people', icon: '🧭', title: 'People in process', answers: 'Where is everyone now, and how is each team doing?', views: [['candidates', 'Where they are'], ['recruitment', 'By team']] },
      { id: 'daily', icon: '📅', title: 'Daily report', answers: 'What was done today, and day by day this month?', views: [['daily', 'Daily report']] },
      { id: 'workflow', icon: '🔀', title: 'Hiring steps', answers: 'Every hiring step, with how many people are at each.', views: [['workflow', 'Hiring steps']] },
    ],
  },
  {
    id: 'people',
    title: 'Team & people',
    cards: [
      { id: 'team', icon: '👥', title: 'Recruiter & BDE performance', answers: 'Who sends people, gets interviews and joinings - and who is reaching target?', views: [['recruiters', 'Performance'], ['targets', 'Against target'], ['coaching', 'Ratios & coaching'], ['costperhire', 'Cost per hire']] },
      { id: 'teamwise', icon: '📥', title: 'Team & person numbers', answers: 'Every number for each team and each person, by day, week or month - and download it.', views: [['teamwise', 'Team & person']] },
    ],
  },
  {
    id: 'clients',
    title: 'Clients & requirements',
    cards: [
      { id: 'clientsjobs', icon: '🏢', title: 'Client-wise requirements', answers: 'Which clients get their requirements filled, and which are stuck?', views: [['clients', 'Clients'], ['requirements', 'Requirements']] },
      { id: 'mybusiness', icon: '💼', title: 'My business', answers: 'My clients, my requirements and my follow-ups in one place.', views: [['mybusiness', 'My business']] },
      { id: 'supply', icon: '⚖️', title: 'Supply vs demand', answers: 'Which specializations need more candidates?', views: [['specialisations', 'Supply vs demand']] },
      { id: 'backdoor', icon: '🚪', title: 'Backdoor hires', answers: 'Who did we send to a client that then joined them without us?', views: [['backdoor', 'Backdoor hires']] },
      { id: 'clienthealth', icon: '🩺', title: 'Client health', answers: 'Are clients happy (NPS), what are they escalating, who stays and who did we lose?', views: [['clienthealth', 'Client health']] },
    ],
  },
  {
    id: 'interviews',
    title: 'Interviews & joining',
    cards: [
      { id: 'interviews', icon: '🗓️', title: 'Interviews', answers: 'Interviews booked, done and waiting for feedback - and the AI interviews.', views: [['interviews', 'Interviews'], ['ai', 'AI interviews']] },
      { id: 'joining', icon: '🤝', title: 'Joinings and drops', answers: 'Who is joining, who joined, who dropped, and the replacements.', views: [['joining', 'Joining'], ['joindrop', 'Joinings and drops']] },
    ],
  },
  {
    id: 'speed',
    title: 'Speed & quality',
    cards: [
      { id: 'ttf', icon: '⚡', title: 'Time to hire', answers: 'How many days to fill a requirement - per requirement, per client and per opening?', views: [['timetofill', 'Time to fill'], ['ttfjob', 'By job & client'], ['openings', 'Per opening']] },
      { id: 'qoh', icon: '⭐', title: 'Quality of hire', answers: 'How do clients rate the people we placed, 30, 60 and 90 days after joining?', views: [['qoh', 'Quality of hire']] },
      { id: 'ops', icon: '⏱️', title: 'Late & waiting', answers: 'What is late: steps past their time, follow-ups not done?', views: [['sla', 'Late steps'], ['followups', 'Follow-ups']] },
      { id: 'rejections', icon: '✋', title: 'Rejections', answers: 'Who rejects people, and why?', views: [['rejections', 'Rejection reasons']] },
      { id: 'overrides', icon: '⚠️', title: 'Added by override', answers: 'Who was added although they did not fit the requirement, and why?', views: [['overrides', 'Added by override']] },
      { id: 'experience', icon: '💬', title: 'Candidate experience', answers: 'How do candidates rate us after interview, offer and joining - complaints, and who leaves the Apply form half-way?', views: [['experience', 'Candidate experience']] },
    ],
  },
  {
    id: 'sources',
    title: 'Sources & money',
    cards: [
      { id: 'sources', icon: '🧲', title: 'Where candidates come from', answers: 'Which sources bring people, and who joins from each?', views: [['came', 'People & dates'], ['sources', 'All sources'], ['quality', 'Best sources'], ['campaigns', 'Campaigns & referrals'], ['partners', 'Partners']] },
      { id: 'portal', icon: '🌐', title: 'Job portal', answers: 'How many people applied from our website?', views: [['jobportal', 'Job portal']] },
      { id: 'revenue', icon: '💰', title: 'Revenue', answers: 'How much did we invoice and receive, month by month?', views: [['revenue', 'Client revenue'], ['recruiter-revenue', 'Recruiter revenue']] },
      { id: 'accounts', icon: '🧾', title: 'Accounts reports', answers: 'Invoices, payments and dues in detail.', link: '/reports/accounts', needs: 'accounts', open: true },
    ],
  },
  {
    // market wave 2026-11-21 (routes/atsInsights.js): forecasts, the report builder, alerts / e-mails, compliance and the BI feed
    id: 'build',
    title: 'Forecast, build & data',
    cards: [
      { id: 'forecast', icon: '🔮', title: 'Forecast & closest to fill', answers: 'How many joinings (and fees) will the pipeline bring, which jobs are nearly filled, and where do people get stuck?', views: [['forecast', 'Pipeline forecast'], ['readiness', 'Closest to fill'], ['bottlenecks', 'Bottlenecks & forecast']] },
      { id: 'builder', icon: '🧩', title: 'Build your own report', answers: 'Pick what, which columns, filters and grouping - or just ask for a chart. Save, share with your team, download.', views: [['builder', 'Build a report'], ['askchart', 'Ask for a chart']] },
      { id: 'schedules', icon: '🔔', title: 'Alerts & scheduled e-mails', answers: 'Tell me when a number crosses my limit, and e-mail my dashboard or a report on a schedule.', views: [['schedules', 'Alerts & e-mails']] },
      { id: 'compliance', icon: '🛡️', title: 'Compliance (DPDP)', answers: 'Consent status, data retention and who opened personal data.', views: [['compliance', 'Compliance (DPDP)']] },
      { id: 'bifeed', icon: '🔌', title: 'BI feed', answers: 'Connect Power BI, Looker Studio or Excel to TeamLink numbers with a read-only key.', views: [['bifeed', 'BI feed']] },
    ],
  },
];

// MAY THIS LOGIN OPEN THIS REPORT? The catalog's answer: a few reports have their own switch, the rest are the role's list
// (catalog.reports; null = every report for a login with ATS Reports).
const OWN_SWITCH = {
  mybusiness: 'myBusiness', jobportal: 'jobPortal', revenue: 'revenue', 'recruiter-revenue': 'recruiterRevenue', experience: 'experience', clienthealth: 'clientHealth',
  // the insight tabs (routes/atsInsights.js): the catalog's flags
  ttfjob: 'insights', openings: 'insights', readiness: 'insights', forecast: 'insights', bottlenecks: 'insights', builder: 'insights', askchart: 'insights',
  schedules: 'insights', coaching: 'insights', // Recruiter insights: ratios, coaching, recorded calls, AI activity (components/atsPlus/RecruiterInsights.jsx)
  backdoor: 'insightsBackdoor', qoh: 'insights', compliance: 'compliance', bifeed: 'biFeed',
};
export function mayOpen(cat, id) {
  if (!cat) return false;
  if (OWN_SWITCH[id]) return !!cat[OWN_SWITCH[id]];
  if (Array.isArray(cat.reports)) return cat.reports.includes(id);
  return !!cat.view;
}

// The card a report tab belongs to (for the views switch and the title).
export function cardOfTab(tab, extraTabs = [], cardId = '') {
  if (cardId) {
    for (const g of REPORT_GROUPS) {
      const c = g.cards.find((x) => x.id === cardId && (x.views || []).some(([id]) => id === tab));
      if (c) return c;
    }
  }
  for (const g of REPORT_GROUPS) {
    const c = g.cards.find((x) => (x.views || []).some(([id]) => id === tab));
    if (c) return c;
  }
  const t = extraTabs.find(([id]) => id === tab);
  return t ? { id: t[0], icon: '📊', title: t[1], answers: '', views: [[t[0], t[1]]] } : null;
}

// May this login open this card? Report cards need ATS Reports (view);
// the others name the catalog flag they need.
function allowed(card, cat) {
  if (!cat) return false;
  if (card.needs) return !!cat[card.needs];
  return (card.views || []).some(([id]) => mayOpen(cat, id));
}

// embedded: drawn under the Reports & Analytics overview (2026-10-08) — the
// overview carries the page title and the scope, so they are not repeated.
// A CLICK ON A CARD THAT HAS JUST MOVED IS NOT TRUSTED (2026-11-27): if something above a card moves it (a banner, a late chart), the card under the pointer
// can change between aiming and clicking. The browser reports every such jump (layout-shift, with the elements that moved); a card that itself moved
// within 0.7 s of the click asks for the click again instead of opening a report the person did not aim at. Movement elsewhere on the page is ignored.
function useCardJumps() {
  const shifts = useRef([]);
  useEffect(() => {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return undefined;
    let po = null;
    try {
      po = new PerformanceObserver((list) => {
        const now = performance.now();
        list.getEntries().forEach((e) => {
          if (e.hadRecentInput) return;
          (e.sources || []).forEach((s) => { if (s.node) shifts.current.push({ t: now, node: s.node }); });
        });
        shifts.current = shifts.current.filter((x) => now - x.t < 1500).slice(-60);
      });
      po.observe({ type: 'layout-shift', buffered: false });
    } catch { po = null; }
    return () => { if (po) po.disconnect(); };
  }, []);
  return (el) => {
    const now = performance.now();
    return !!el && shifts.current.some((x) => now - x.t < 700 && x.node && (x.node === el || (x.node.contains && x.node.contains(el)) || el.contains(x.node)));
  };
}

export default function ReportsHome({ tabs = [], onOpen, onOpenPage, embedded = false }) {
  const cat = useReportCatalog();
  const justMoved = useCardJumps();
  const [moved, setMoved] = useState('');
  const open = (c, el) => {
    if (justMoved(el)) { setMoved(c.id); setTimeout(() => setMoved((m) => (m === c.id ? '' : m)), 2500); return; }
    onOpen(c.views[0][0], c.id);
  };
  const known = new Set(REPORT_GROUPS.flatMap((g) => g.cards.flatMap((c) => (c.views || []).map(([id]) => id))));
  const extra = tabs.filter(([id]) => !known.has(id)).map(([id, label]) => ({ id, icon: '📊', title: label, answers: '', views: [[id, label]] }));
  const groups = REPORT_GROUPS.map((g) => ({
    ...g,
    cards: [...g.cards, ...(g.id === 'speed' ? extra : [])]
      // only the views that are still a tab here AND that this login opens; a card with none left is not shown
      .map((c) => (c.link ? c : { ...c, views: c.views.filter(([id]) => tabs.some(([t]) => t === id) && mayOpen(cat, id)) }))
      .filter((c) => c.link || c.views.length)
      .filter((c) => allowed(c, cat)),
  })).filter((g) => g.cards.length);

  return (
    <div className="rphome">
      {!embedded && <ListPageHeader title="Reports" question="Numbers about our hiring. Pick a question below — each card opens the report that answers it." />}
      {!embedded && cat && cat.scope && <div className="rphome-scope">Your area: <b>{cat.scope}</b></div>}
      {!cat && <div className="small-muted">Loading your reports…</div>}
      {cat && !groups.length && <div className="notice">No reports are part of your role yet. Ask your admin if you need one.</div>}
      {groups.map((g) => (
        <section key={g.id}>
          <h2>{g.title}</h2>
          <div className="rphome-grid">
            {g.cards.map((c) => {
              const body = (
                <>
                  <span className="rphome-ic" aria-hidden="true">{c.icon}</span>
                  <span>
                    <span className="rphome-t">{c.title}</span>
                    {c.answers && <span className="rphome-a">{c.answers}</span>}
                    {c.id === 'revenue' && <span className="rphome-lock">Only Super Admin, Admin and Accounts see this</span>}
                    {c.views && c.views.length > 1 && <span className="rphome-views">{c.views.map(([, l]) => l).join(' · ')}</span>}
                    {moved === c.id && <span className="rphome-lock" role="status">The page moved as you clicked - click {c.title} again.</span>}
                  </span>
                </>
              );
              return c.link
                ? (onOpenPage ? <button key={c.id} type="button" className="rphome-card" data-card={c.id} onClick={() => onOpenPage(c)}>{body}</button> : <Link key={c.id} className="rphome-card" to={c.link}>{body}</Link>)
                : <button key={c.id} type="button" className="rphome-card" data-card={c.id} onClick={(e) => open(c, e.currentTarget)}>{body}</button>;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
