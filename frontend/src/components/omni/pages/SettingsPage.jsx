import { useSearchParams } from 'react-router-dom';
import { PageHead } from '../ui.jsx';
import { useOmni } from '../omniContext.js';
import SetOrg from '../admin/SetOrg.jsx';
import SetIntegrations from '../admin/SetIntegrations.jsx';
import SetChannels from '../admin/SetChannels.jsx';
import SetCompliance from '../admin/SetCompliance.jsx';
import { AccountTab, SecurityTab, NotificationsTab, ApiKeysTab, WebhooksTab, AuditTab } from '../admin/SetMisc.jsx';

// Settings (prototype "Workspace administration"): the prototype's tabs mapped to what TeamLink really has. Admin only (the server's pagesFor decides).
// The old ?tab= words of the five-hub build (whatsapp, channels, departments, sender, rules, consent) still land on the right tab.
const TABS = [
  ['org', '🏢 Organisation'], ['integrations', '🔗 Integrations'], ['channels', '📡 Channels & sending'], ['compliance', '🛡 Compliance'], ['account', '👤 Account'],
  ['security', '🔒 Security'], ['notifications', '🔔 Notifications'], ['apikeys', '🔑 API keys'], ['webhooks', '🪝 Webhooks'], ['audit', '📜 Audit log'],
];
const ALIAS = { profile: 'org', departments: 'org', whatsapp: 'integrations', meta: 'integrations', sender: 'channels', rules: 'channels', consent: 'compliance', dlt: 'compliance' };
export default function SettingsPage() {
  const { toast } = useOmni();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab = TABS.some(([id]) => id === raw) ? raw : (ALIAS[raw] || 'integrations');
  const setTab = (t) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  return (
    <div>
      <PageHead eyebrow="Workspace administration" title="Settings" lead="Manage your account preferences and integrations." />
      <div className="adm-tabs-wrap">
        <div className="set-tabs" role="tablist">
          {TABS.map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} className={`set-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
      {tab === 'org' && <SetOrg toast={toast} />}
      {tab === 'integrations' && <SetIntegrations toast={toast} />}
      {tab === 'channels' && <SetChannels toast={toast} />}
      {tab === 'compliance' && <SetCompliance toast={toast} />}
      {tab === 'account' && <AccountTab />}
      {tab === 'security' && <SecurityTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'apikeys' && <ApiKeysTab />}
      {tab === 'webhooks' && <WebhooksTab toast={toast} />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
