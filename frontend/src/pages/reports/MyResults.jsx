// Reports -> My Results (per-role spec 2026-10-03): a recruiter's own
// numbers — submitted, interviews, selected, joined — over their own jobs.
import { useAuth } from '../../context/AuthContext.jsx';
import { can } from '../../permissions';
import OwnResults from '../../components/OwnResults.jsx';
import DailyReport from './DailyReport.jsx';

// This month so far, as local dates.
function thisMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

export default function MyResults() {
  const { user } = useAuth();
  return (
    <>
    {/* This month's numbers — no date inputs or download of their own: the
        Daily report below has the page's one date control and its Excel /
        PDF / CSV buttons (simplicity checklist 2026-10-03). */}
    <OwnResults
      endpoint="/ats-reports/my-results"
      title="My Results"
      sub="Your own jobs and people"
      mayExport={can(user, null, 'reports', 'My Results', 'export')}
      fixed={thisMonth()}
    />
    {/* My day / my month of work (spec 2026-10-03 C2) — the server shows a recruiter only their own. */}
    <h3 style={{ margin: '20px 0 8px' }}>My daily work</h3>
    <DailyReport />
    </>
  );
}
