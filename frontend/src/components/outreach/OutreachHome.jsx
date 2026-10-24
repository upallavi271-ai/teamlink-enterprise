import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { viewAsToken, actAsMode } from '../../api';
import Contacts from './Contacts.jsx';
import Groups from './Groups.jsx';
import Campaigns from './Campaigns.jsx';
import Distribution from './Distribution.jsx';
import ScheduledMessages from './ScheduledMessages.jsx';
import HubTemplates from './HubTemplates.jsx';
import Automations from './Automations.jsx';
import Dashboard from './Dashboard.jsx';
import Communication from './Communication.jsx';
import { Performance, Roi, CreditsHub } from './Insights.jsx';
import { Reports } from './OverviewReports.jsx';
import { MetaWhatsapp, Departments, Permissions, ConfigSettings, ChannelsConfig } from './ConfigHub.jsx';
import { HUBS, resolveNav, readStored, writeStored } from './omniNav.js';
import { hubPath } from './omniSidebar.js';
import '../broadcast/broadcast.css';
import './outreach.css';
import './omni.css';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL PAGE. The sidebar has ONE group, "Omni-Channel", and its children are the five hubs (founder, 2026-10-17):
//   /omni-channel/dashboard | communication | campaigns | insights | configuration     (Configuration: Admins only)
// so this page draws only the sub-tabs of the open hub (no second row of hubs). The address is the truth: /omni-channel/<hub>?tab=<sub tab>
// (+ &aud=internal for the staff side of Campaigns). Old addresses (/omni, ?mode=promo&tab=contacts, ?tab=channels ...) are sent to their new place
// (omniNav.js legacyTarget). What a login sees comes from GET /api/outreach/me; the server checks every route again. Server: /api/outreach.
// ---------------------------------------------------------------------------
export default function OutreachHome(props) {
  return <TeamLinkOutreach {...props} />;
}

const JUMP = { campaigns: ['campaigns', 'campaigns'], inbox: ['communication', 'inbox'] };
const to = (hub, tab, aud) => `${hubPath(hub)}?tab=${tab}${hub === 'campaigns' && aud === 'internal' ? '&aud=internal' : ''}`;

function TeamLinkOutreach({ user }) { // eslint-disable-line no-unused-vars
  const { hub: hubParam } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const [acc, setAcc] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let on = true;
    api.get('/outreach/me').then(async (me) => {
      let old = {};
      try { old = (await api.get('/outreach/access')).data; } catch { old = { ready: false, campaignsReady: false }; } // Finance has no recruitment access: only /me
      if (on) setAcc({ ...old, ...me.data });
    }).catch((e) => { if (on) setErr(e.response?.data?.error || 'Omni-Channel could not be opened.'); });
    return () => { on = false; };
  }, []);
  const nav = acc ? resolveNav(acc, { hub: hubParam, tab: sp.get('tab'), mode: sp.get('mode'), aud: sp.get('aud') }, readStored()) : null;
  useEffect(() => { if (nav && nav.hub) writeStored(nav.hub); }, [nav && nav.hub]); // eslint-disable-line react-hooks/exhaustive-deps
  // an old or incomplete address is rewritten to the canonical one
  useEffect(() => {
    if (!nav || nav.none) return;
    const want = to(nav.hub, nav.tab, nav.aud);
    const have = `${pathname}${sp.toString() ? `?${sp.toString()}` : ''}`;
    if (have !== want) navigate(want, { replace: true });
  }, [nav && nav.hub, nav && nav.tab, nav && nav.aud, pathname, sp.toString()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="oc-page"><div className="bc-err" role="alert">{err}</div></div>;
  if (!acc) return <div className="oc-page"><div className="oc-note">Loading…</div></div>;
  if (nav.none) return <div className="oc-page"><div className="bc-warn" role="status">There is nothing for your login in Omni-Channel yet.</div></div>;

  const { hub, tab, subs, aud } = nav;
  const goTab = (t) => navigate(to(hub, t, aud), { replace: true });
  const goAud = (a) => navigate(to('campaigns', a === 'internal' ? 'messages' : 'campaigns', a), { replace: true });
  const jump = (id) => { const j = JUMP[id]; if (j) navigate(to(j[0], j[1], 'promo'), { replace: true }); };
  const viewing = !!viewAsToken() && !actAsMode(); // View as = read-only
  const ready = acc.ready;
  const promoType = 'candidate_lead';
  const needsSetup = !ready && hub === 'campaigns' && !['templates', 'automations'].includes(tab);

  const body = () => {
    if (hub === 'dashboard') return <Dashboard acc={acc} go={jump} />;
    if (hub === 'communication') return <Communication acc={acc} tab={tab} />;
    if (hub === 'insights') {
      if (tab === 'performance') return <Performance acc={acc} />;
      if (tab === 'credits') return <CreditsHub acc={acc} />;
      if (tab === 'roi') return <Roi />;
      return <Reports acc={acc} />;
    }
    if (hub === 'configuration') {
      if (tab === 'meta') return <MetaWhatsapp />;
      if (tab === 'channels') return <ChannelsConfig />;
      if (tab === 'departments') return <Departments />;
      if (tab === 'permissions') return <Permissions />;
      return <ConfigSettings />;
    }
    if (hub === 'campaigns') {
      if (tab === 'templates') return <HubTemplates acc={acc} />;
      if (tab === 'automations') return <Automations acc={acc} />;
      if (!ready) return null;
      if (aud === 'internal') {
        if (tab === 'messages') return <Campaigns acc={acc} type="internal" />;
        if (tab === 'people') return <Contacts acc={acc} type="internal" only="people" />;
        if (tab === 'groups') return <Contacts acc={acc} type="internal" only="groups" />;
        if (tab === 'imports') return <Contacts acc={acc} type="internal" only="imports" />;
        if (tab === 'scheduled') return <ScheduledMessages />;
        return null;
      }
      if (tab === 'campaigns') return <Campaigns acc={acc} type={promoType} group="campaign" />;
      if (tab === 'promotions') return <Campaigns acc={acc} type={promoType} group="promotion" />;
      if (tab === 'contacts') return <Contacts acc={acc} type={promoType} only="contacts" />;
      if (tab === 'audiences') return <Groups acc={acc} type={promoType} word="Audiences" />;
      if (tab === 'distribution') return <Distribution />;
    }
    return null;
  };

  return (
    <div className="oc-page">
      <div className="oc-head">
        <h2>{HUBS[hub].label}</h2>
        <div className="oc-note">{HUBS[hub].sub}{acc.levelWords ? ` You are signed in as: ${acc.levelWords}.` : ''}</div>
      </div>
      {viewing && <div className="oc-viewas" role="status"><b>You are in View as mode: this page is read-only.</b> Import and Add need &quot;Switch to Act as (edit)&quot;.</div>}
      {needsSetup && <div className="bc-warn" role="status">Omni-Channel contacts and campaigns are being set up. They will open in a little while.</div>}
      {hub === 'campaigns' && nav.audChoices.length > 1 && (
        <div className="oc2-aud"><span className="oc-note">Showing:</span>{nav.audChoices.map(([id, label]) => <button type="button" key={id} className={`oc2-chip${aud === id ? ' on' : ''}`} aria-pressed={aud === id} onClick={() => goAud(id)}>{label}</button>)}</div>
      )}
      {subs.length > 1 && (
        <div className="oc-tabs" role="tablist" aria-label={`${HUBS[hub].label} menu`}>
          {subs.map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} className={`oc-tab${tab === id ? ' on' : ''}`} onClick={() => goTab(id)}>{label}</button>)}
        </div>
      )}
      {body()}
    </div>
  );
}
