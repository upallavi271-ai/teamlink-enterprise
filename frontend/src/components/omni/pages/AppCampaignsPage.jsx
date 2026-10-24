import { PageHead } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import AppCampaignList from '../library/AppCampaignList.jsx';

// CAMPAIGNS > From other apps: the campaigns made on the ATS (candidates), Job Portal (applicants), HRMS (employees) and Accounts (invoice reminders, payment follow-ups)
// screens, followed in one place: Save for later, approval, Send now / Schedule, Pause / Resume / Cancel, and a plain status for every person. Server: /api/omni/app-campaigns.
export default function AppCampaignsPage() {
  const { toast } = useOmni();
  return (
    <div>
      <PageHead eyebrow="Made on the app screens" title="Campaigns from other apps" lead="Campaigns started from the ATS, Job Portal, HRMS and Accounts screens. You see your own; Team Leads see their department's; Accounts campaigns stay in Accounts." />
      <AppCampaignList toast={toast} />
    </div>
  );
}
