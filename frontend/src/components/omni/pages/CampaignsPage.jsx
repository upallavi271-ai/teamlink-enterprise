import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useOmni } from '../omniContext.js';
import CampaignAnalytics from '../campaigns/CampaignAnalytics.jsx';
import CampaignDetail from '../campaigns/CampaignDetail.jsx';
import CampaignList from '../campaigns/CampaignList.jsx';
import CampaignWizard from '../campaigns/CampaignWizard.jsx';
import MessageLogsModal from '../campaigns/MessageLogsModal.jsx';
import '../campaigns/campaigns.css';

// Omni-Channel > Campaigns (the prototype's All Campaigns). One page, three views kept in the address so Back works:
//   /omni-channel/campaigns                  the list (channel tabs, status tabs, table, row actions)
//   /omni-channel/campaigns?c=<key>          the command center of one campaign (7 tabs; &dt=<tab>)
//   /omni-channel/campaigns?c=<key>&v=analytics   the analytics page (and the Live Message Logs window)
// The Create campaign wizard opens on top of whichever view you are on.
export default function CampaignsPage() {
  const { go } = useOmni();
  const [sp] = useSearchParams();
  // other pages link here with ?open=<key> (a campaign), ?new=1 (open the Create campaign window) or ?segment=<id> (Create campaign with that group picked)
  const key = sp.get('c') || sp.get('open');
  const view = sp.get('v');
  const [wizard, setWizard] = useState(null); // null | { editKey }
  const [logs, setLogs] = useState(null); // null | { key }
  useEffect(() => { if (sp.get('new') || sp.get('segment')) setWizard({ segment: sp.get('segment') || undefined }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tick, setTick] = useState(0); // makes the list load again after the wizard

  const open = (k) => go('campaigns', { c: k });
  const analytics = (k) => go('campaigns', { c: k, v: 'analytics' });
  const list = () => go('campaigns');
  const done = (r) => {
    setWizard(null); setTick((t) => t + 1);
    if (r && r.key) open(r.key); else list();
  };
  let body;
  if (key && view === 'analytics') body = <CampaignAnalytics key={`a${key}`} campaignKey={key} onBack={list} />;
  else if (key) body = <CampaignDetail key={`d${key}${tick}`} campaignKey={key} onBack={list} onAnalytics={analytics} onEdit={(k) => setWizard({ editKey: k })} onLogs={(k) => setLogs({ key: k })} onOpen={open} />;
  else body = <CampaignList key={`l${tick}`} onOpen={open} onAnalytics={analytics} onNew={() => setWizard({})} onEdit={(k) => setWizard({ editKey: k })} />;
  return (
    <div>
      {body}
      {wizard && <CampaignWizard key={wizard.editKey || 'new'} editKey={wizard.editKey} initialSegment={wizard.segment} onClose={() => setWizard(null)} onDone={done} />}
      {logs && <MessageLogsModal campaignKey={logs.key} onClose={() => setLogs(null)} />}
    </div>
  );
}
