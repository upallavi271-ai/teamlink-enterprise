import { useState } from 'react';
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
import { useAuth } from '../../context/AuthContext.jsx';
import { isHR as hasHrmsAdmin, isSuperAdmin } from '../../permissions';

// Who the Recruiter joinings tab is for: Super Admin, the HR / Admin desk,
// TLs (their team) and recruiters (their own). The server scopes the rows.
function seesJoinings(user) {
  if (!user) return false;
  const ats = (user.scopeRoles && user.scopeRoles.ats) || user.atsRole || user.role;
  return isSuperAdmin(user) || hasHrmsAdmin(user) || ['TL', 'STL', 'RECRUITER'].includes(ats);
}

export default function PerformanceDevelopment() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const joinings = seesJoinings(user);
  const tabs = [
    { key: 'targets', label: 'Monthly Targets', element: <Targets /> },
    ...(joinings ? [{ key: 'joinings', label: 'Recruiter joinings', element: <RecruiterJoinings /> }] : []),
    { key: 'recognition', label: 'Reward & Recognition', element: <Recognition /> },
    { key: 'kt', label: 'Knowledge Transfer', element: <KT /> },
    { key: 'disciplinary', label: 'Disciplinary Actions', element: <Disciplinary /> },
    { key: 'lms', label: 'LMS', element: <Lms /> },
    { key: 'projects', label: 'Projects', element: <Projects /> },
    { key: 'reports', label: 'Reports', element: <Performance /> },
  ];
  // ?tab=joinings opens a tab directly (the HRMS popup's "Open full screen").
  const want = params.get('tab');
  const [active, setActive] = useState(tabs.some((t) => t.key === want) ? want : tabs[0].key);
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
