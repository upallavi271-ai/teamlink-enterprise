import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import TabsPage from '../../components/TabsPage.jsx';
import Targets from './Targets.jsx';
import Recognition from './Recognition.jsx';
import KT from './KT.jsx';
import Disciplinary from './Disciplinary.jsx';
import Lms from './Lms.jsx';
import Performance from './Performance.jsx';
import Projects from './Projects.jsx';
// Recruiter joinings vs target + Super Admin's incentive / raise (2026-10-05).
import RecruiterJoinings from './RecruiterJoinings.jsx';
// Role-wise recruitment performance: generated / selected / joined per role, employee and month (2026-10-13).
import RolePerformance from '../../components/rolePerformance/RolePerformance.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, isSuperAdmin } from '../../permissions';
import './performance-merged.css';

// Who the Recruiter joinings tab is for: Super Admin, the HR / Admin desk,
// TLs (their team) and recruiters (their own). The server scopes the rows.
function seesJoinings(user) {
  if (!user) return false;
  const ats = (user.scopeRoles && user.scopeRoles.ats) || user.atsRole || user.role;
  return isSuperAdmin(user) || hasHrmsAdmin(user) || ['TL', 'STL', 'RECRUITER'].includes(ats);
}
// The role-wise performance section: the same people, plus the managers and the BDE team (the server scopes every row).
function seesRolePerformance(user) {
  if (!user) return false;
  const ats = (user.scopeRoles && user.scopeRoles.ats) || user.atsRole || user.role;
  return seesJoinings(user) || ['MANAGER', 'ASSISTANT_MANAGER', 'ADMIN', 'BDE'].includes(ats);
}

export default function PerformanceDevelopment() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const joinings = seesJoinings(user);
  const rolePerf = seesRolePerformance(user);
  // ONE tab (user, 2026-10-09): Monthly Targets, with the recruiter joinings on the
  // same screen as their own section (counts only; who joined is in ATS).
  const tabs = [
    {
      key: 'targets',
      label: 'Monthly Targets',
      element: (
        <div className="pd-merged">
          <section className="pd-section" id="pd-targets">
            <h2 className="pd-h2">Monthly targets</h2>
            <Targets />
          </section>
          {joinings && (
            <section className="pd-section" id="pd-joinings">
              <h2 className="pd-h2">Recruiter joinings</h2>
              <RecruiterJoinings />
            </section>
          )}
          {rolePerf && (
            <section className="pd-section" id="pd-role-performance">
              <h2 className="pd-h2">Recruitment performance by role</h2>
              <RolePerformance />
            </section>
          )}
        </div>
      ),
    },
    { key: 'recognition', label: 'Reward & Recognition', element: <Recognition /> },
    { key: 'kt', label: 'Knowledge Transfer', element: <KT /> },
    { key: 'disciplinary', label: 'Disciplinary Actions', element: <Disciplinary /> },
    { key: 'lms', label: 'LMS', element: <Lms /> },
    { key: 'projects', label: 'Projects', element: <Projects /> },
    { key: 'reports', label: 'Reports', element: <Performance /> },
  ];
  // The old ?tab=joinings address (the HRMS popup's "Open full screen", "See my
  // joinings") opens the merged tab and scrolls to the joinings section.
  const raw = params.get('tab');
  const want = raw === 'joinings' ? 'targets' : raw;
  const [active, setActive] = useState(tabs.some((t) => t.key === want) ? want : tabs[0].key);
  useEffect(() => {
    if (raw !== 'joinings') return undefined;
    const t = setTimeout(() => { const el = document.getElementById('pd-joinings'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 600);
    return () => clearTimeout(t);
  }, [raw]);
  return (
    <TabsPage
      title="Performance & Development"
      subtitle="Targets, recognition, knowledge transfer, discipline and learning"
      value={active}
      onChange={setActive}
      tabs={tabs}
    />
  );
}
