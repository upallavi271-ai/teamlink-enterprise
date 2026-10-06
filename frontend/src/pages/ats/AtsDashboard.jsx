import AtsHome from '../../components/dashboard/AtsHome.jsx';
import './AtsDashboard.css';

// User feedback 2026-10-03 #3: ONE dashboard for every role, Super Admin
// included — the ATS home (components/dashboard/AtsHome.jsx). The old
// Operations / Management / Admin tabs are gone; an old ?tab= link lands here.
export default function AtsDashboard() {
  return <AtsHome />;
}
