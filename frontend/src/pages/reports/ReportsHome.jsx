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
// ATS layout v3 §5 (2026-10-03): the seven chart reports first — each its
// own card, at most three charts on its screen — then everything that was
// here before (Daily report, Supply vs demand, Results vs target, Time to
// fill … all still one click away). The same report may sit on two cards; the
// card it was opened from rides in the URL (?card=) for its views switch.
export const REPORT_GROUPS = [
  {
    id: 'main',
    title: 'Main reports',
    cards: [
      { id: 'clientsjobs', icon: '🏢', title: 'Client-wise jobs & joinings', answers: 'Which clients get their jobs filled, and which are stuck?', views: [['clients', 'Clients'], ['requirements', 'Jobs'], ['specialisations', 'Supply vs demand']] },
      { id: 'depts', icon: '🗂️', title: 'Department performance', answers: 'How is each department doing, from open jobs to joined?', views: [['departments', 'Departments'], ['funnel', 'Funnel']] },
      { id: 'team', icon: '👥', title: 'Recruiter & BDE performance', answers: 'Who sends people, gets interviews and joinings?', views: [['recruiters', 'Recruiters & BDEs'], ['targets', 'Against target'], ['costperhire', 'Cost per hire']] },
      { id: 'rejections', icon: '✋', title: 'Rejection analysis', answers: 'Who rejects people, and why?', views: [['rejections', 'Rejection reasons']] },
      { id: 'ttf', icon: '⚡', title: 'Time to hire', answers: 'How many days to fill a job, and how long each step takes?', views: [['timetofill', 'Time to fill'], ['sla', 'Time in each step']] },
      { id: 'sources', icon: '🧲', title: 'Source-wise candidates', answers: 'Where do candidates come from, and who joins?', views: [['sources', 'All sources'], ['quality', 'Best sources'], ['campaigns', 'Campaigns & referrals'], ['partners', 'Partners']] },
      { id: 'revenue', icon: '💰', title: 'Revenue', answers: 'How much did we invoice and receive, month by month?', views: [['revenue', 'Client revenue'], ['recruiter-revenue', 'Recruiter revenue']], needs: 'revenue' },
    ],
  },
  {
    id: 'more',
    title: 'More reports',
    cards: [
      { id: 'daily', icon: '📅', title: 'Daily report', answers: 'What did each recruiter do today?', views: [['daily', 'Daily report']] },
      { id: 'supply', icon: '⚖️', title: 'Supply vs demand', answers: 'Which specializations need more candidates?', views: [['specialisations', 'Supply vs demand']] },
      { id: 'targets', icon: '🎯', title: 'Results vs target', answers: 'Who is reaching their target this month?', views: [['targets', 'Against target'], ['recruiters', 'All numbers']] },
      { id: 'funnel', icon: '🔻', title: 'Funnel', answers: 'How many people go from applied to joined?', views: [['funnel', 'Steps'], ['departments', 'By department']] },
      { id: 'people', icon: '🧭', title: 'People in process', answers: 'Where is everyone now, and who waits too long?', views: [['candidates', 'Where they are'], ['recruitment', 'By team']] },
      { id: 'ops', icon: '⏱️', title: 'Late and waiting', answers: 'What is late: steps, follow-ups, interviews, joining?', views: [['sla', 'Late and waiting'], ['followups', 'Follow-ups'], ['interviews', 'Interviews'], ['joining', 'Joining'], ['ai', 'AI interviews']] },
      // B8: people added although they did not meet the job's rules.
      { id: 'overrides', icon: '⚠️', title: 'Added by override', answers: 'Who was added although they did not fit the job, and why?', views: [['overrides', 'Added by override']] },
      { id: 'workflow', icon: '🔀', title: 'Hiring steps', answers: 'All hiring steps, with how many people are at each.', views: [['workflow', 'Hiring steps']] },
      { id: 'myresults', icon: '🏁', title: 'My results', answers: 'What did I send, and who joined?', link: '/reports/my-results', needs: 'myResults', open: true },
      { id: 'portal', icon: '🌐', title: 'Job portal', answers: 'How many people applied from our website?', views: [['jobportal', 'Job portal']], needs: 'jobPortal' },
      { id: 'accounts', icon: '🧾', title: 'Accounts reports', answers: 'Invoices, payments and dues in detail.', link: '/reports/accounts', needs: 'accounts', open: true },
    ],
  },
];

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
  return !!cat.view;
}

// embedded: drawn under the Reports & Analytics overview (2026-10-08) — the
// overview carries the page title and the scope, so they are not repeated.
export default function ReportsHome({ tabs = [], onOpen, embedded = false }) {
  const cat = useReportCatalog();
  const known = new Set(REPORT_GROUPS.flatMap((g) => g.cards.flatMap((c) => (c.views || []).map(([id]) => id))));
  const extra = tabs.filter(([id]) => !known.has(id)).map(([id, label]) => ({ id, icon: '📊', title: label, answers: '', views: [[id, label]] }));
  const groups = REPORT_GROUPS.map((g) => ({
    ...g,
    cards: [...g.cards, ...(g.id === 'more' ? extra : [])]
      // a report card shows only when its first view is still a tab here
      .filter((c) => c.link || tabs.some(([id]) => id === c.views[0][0]))
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
                  </span>
                </>
              );
              return c.link
                ? <Link key={c.id} className="rphome-card" to={c.link}>{body}</Link>
                : <button key={c.id} type="button" className="rphome-card" onClick={() => onOpen(c.views[0][0], c.id)}>{body}</button>;
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
