import { Link, useSearchParams } from 'react-router-dom';
import ListPageHeader from '../../components/ui/ListPageHeader.jsx';
import MissedItemsBox from '../../components/MissedItemsBox.jsx';
import TeamReports from './TeamReports.jsx';
import DailyReport from './DailyReport.jsx';
import AtsReports from './AtsReports.jsx';
import './OwnReports.css';

// ---------------------------------------------------------------------------
// A RECRUITER'S REPORTS = THEIR OWN NUMBERS ONLY (user, 2026-10-12: "Recruiter ki Reports lo, only valla Reports
// matrame visible").
//
// Four buttons, nothing about teams, clients, the company's sources, other recruiters or money:
//   My results      what I did: new profiles, calls, mails, follow-ups done, sent to team lead / client,
//                   interviews, offers, joined. Today / Yesterday / This week / This month / Custom, Day by day,
//                   Download Excel and Download PDF of my own (the Team & person screen, which the server cuts to me)
//   My progress     where my candidates are: screened, sent, interviewed, selected, joined
//   My follow-ups   mine that are done, due today or late, with "My missed items"
//   My daily report what I did on one day, hour by hour
//
// The server is the wall (utils/ownOnly.js): this screen only hides. A person, team or client asked for in the
// address is dropped there and the answer is still mine.
// ---------------------------------------------------------------------------
const TABS = [
  ['results', 'My results', 'What I did: calls, mails, follow-ups, sent to team lead and client, interviews, offers, joined.'],
  ['progress', 'My progress', 'Where my candidates are now, and how far they got.'],
  ['followups', 'My follow-ups', 'Which of my follow-ups are done, due today or late.'],
  ['day', 'My daily report', 'What I did on one day.'],
];
// Old addresses (?tab=daily, ?tab=teamwise ...) land on the nearest own tab.
const OLD = {
  daily: 'day', teamwise: 'results', recruiters: 'results', funnel: 'progress', candidates: 'progress', followups: 'followups', interviews: 'progress', joining: 'progress',
};

export default function OwnReports() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('my') || OLD[params.get('tab')] || 'results';
  const tab = TABS.some(([id]) => id === asked) ? asked : 'results';
  const pick = (id) => setParams({ my: id });
  const about = (TABS.find(([id]) => id === tab) || [])[2];

  return (
    <div className="own-reports">
      <ListPageHeader title="My reports" question="Only your own numbers. Pick what you want to see." sub={<>Your area: <b>Your own numbers</b></>} />
      <div className="orp-tabs" role="tablist" aria-label="My reports">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`orp-tab${tab === id ? ' on' : ''}`} onClick={() => pick(id)}>{label}</button>
        ))}
      </div>
      {about && <p className="orp-about">{about}</p>}

      {tab === 'results' && <TeamReports embedded />}
      {tab === 'progress' && (
        <>
          <AtsReports fixedTab="funnel" />
          <div className="orp-links">
            <Link className="btn btn-sm" to="/candidates">Open my candidates</Link>
          </div>
        </>
      )}
      {tab === 'followups' && (
        <>
          <MissedItemsBox />
          <AtsReports fixedTab="followups" />
          <div className="orp-links">
            <Link className="btn btn-sm btn-primary" to="/ats/team?view=followups">Open my follow-ups list</Link>
          </div>
        </>
      )}
      {tab === 'day' && <DailyReport />}
    </div>
  );
}
