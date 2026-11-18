import { useParams } from 'react-router-dom';
import { AppOmniBody } from './AppOmniPanel.jsx';
import './library/library.css';

// The Omni-Channel "Templates & campaigns" of one app, bare (no TeamLink sidebar / header): /embed/app-omni/Job%20Portal.
// The Job Portal's own "Templates & Campaigns" button shows this page in a window (job-portal-app/embed/omni-panel-addon.js), so a
// recruiter sees the same templates and campaigns, in the same format, as in Omni-Channel. Same TeamLink sign-in as everywhere else.
const APPS = ['ATS', 'Job Portal', 'HRMS', 'Accounts'];
export default function AppOmniEmbed() {
  const { app } = useParams();
  const name = APPS.includes(app) ? app : 'Job Portal';
  return (
    <div className="gsx" style={{ minHeight: '100vh', display: 'block', padding: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>{name}: templates and campaigns</div>
      <AppOmniBody app={name} />
    </div>
  );
}
