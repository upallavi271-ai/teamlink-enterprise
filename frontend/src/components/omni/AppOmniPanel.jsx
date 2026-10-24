import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { shared } from './omniApi.js';
import { GsModal, Tabs } from './ui.jsx';
import TemplateLibrary from './library/TemplateLibrary.jsx';
import AppCampaignList from './library/AppCampaignList.jsx';
import './library/library.css';

// ---------------------------------------------------------------------------
// "TEMPLATES & CAMPAIGNS" inside an app screen (ATS, Job Portal, HRMS, Accounts). It is a button in the screen's own toolbar (no new sidebar entry). It opens the
// SHARED template library cut to the templates that app may use, and the campaigns made from that app's screens (with the same tracking as Omni-Channel).
// The server holds both lists to what this login may see, so the same button is safe on every screen.
//   <AppOmniPanel app="HRMS" />        app: 'ATS' | 'Job Portal' | 'HRMS' | 'Accounts'
// ---------------------------------------------------------------------------
export default function AppOmniPanel({ app, label = 'Templates & campaigns', className = 'btn' }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('templates');
  const [msg, setMsg] = useState('');
  const [omniPages, setOmniPages] = useState([]);
  const navigate = useNavigate();
  useEffect(() => { if (open && app === 'Job Portal') shared.get('/me').then((r) => setOmniPages(r.omniPages || [])).catch(() => {}); }, [open, app]);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={`The shared template library for ${app}, and the campaigns made from ${app} screens`}>{label}</button>
      {open && (
        <div className="gsx" style={{ background: 'transparent', minHeight: 0, overflow: 'visible', display: 'block' }}>
          <GsModal title={`${app}: templates and campaigns`} sub="One library for every app. Pick a message here, or follow a campaign you made." width={1000} onClose={() => setOpen(false)}>
            <Tabs value={tab} onChange={setTab} tabs={[['templates', 'Templates'], ['campaigns', 'Campaigns'], ...(app === 'Job Portal' ? [['promote', 'Promote a job']] : [])]} />
            {msg && <div className="lib-sub" role="status" style={{ margin: '6px 0' }}>{msg}</div>}
            <div style={{ marginTop: 10 }}>
              {tab === 'templates' && <TemplateLibrary app={app} embedded toast={setMsg} />}
              {tab === 'campaigns' && <AppCampaignList app={app} embedded toast={setMsg} />}
              {tab === 'promote' && (
                <div className="lib-box">
                  <b>Promote a job to candidates.</b>
                  <p className="lib-sub" style={{ fontSize: 11 }}>A job promotion sends the job and its apply link to the people you pick, with a tracked link that counts who opened it and who applied. It is made in Omni-Channel &gt; Campaigns, from a requirement that is open and published. To message the people who already applied through the portal, use "Message these" on the Job Portal candidates list and press "Make it a campaign".</p>
                  {omniPages.includes('campaigns') ? <button type="button" className="btn btn-primary" onClick={() => navigate('/omni-channel-native/campaigns')}>Open Omni-Channel Campaigns</button> : <p className="lib-sub">Your login does not make job promotions. Ask a Team Lead or the BDE team.</p>}
                </div>
              )}
            </div>
          </GsModal>
        </div>
      )}
    </>
  );
}
