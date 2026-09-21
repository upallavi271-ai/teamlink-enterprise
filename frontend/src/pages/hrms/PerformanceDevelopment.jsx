import TabsPage from '../../components/TabsPage.jsx';
import Targets from './Targets.jsx';
import Recognition from './Recognition.jsx';
import KT from './KT.jsx';
import Disciplinary from './Disciplinary.jsx';
import Lms from './Lms.jsx';
import Performance from './Performance.jsx';
import Projects from './Projects.jsx';

export default function PerformanceDevelopment() {
  return (
    <TabsPage
      title="Performance & Development"
      subtitle="Targets, recognition, knowledge transfer, discipline and learning"
      tabs={[
        { key: 'targets', label: 'Monthly Targets', element: <Targets /> },
        { key: 'recognition', label: 'Reward & Recognition', element: <Recognition /> },
        { key: 'kt', label: 'Knowledge Transfer', element: <KT /> },
        { key: 'disciplinary', label: 'Disciplinary Actions', element: <Disciplinary /> },
        { key: 'lms', label: 'LMS', element: <Lms /> },
        { key: 'projects', label: 'Projects', element: <Projects /> },
        { key: 'reports', label: 'Reports', element: <Performance /> },
      ]}
    />
  );
}
