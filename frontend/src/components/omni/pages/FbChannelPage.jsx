import { useState } from 'react';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned, fmtNum } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import ChannelSettingsModal from '../external/ChannelSettingsModal.jsx';
import { Metric, Metrics, Toggle, SimpleTable, LoadError } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Facebook channel hub (prototype page fbchannel). Real states only: connect the Page (Admin), then the Page name and followers the read-only check returned.
// Messenger conversations, response time and Page posts are "Not synced yet" (planned): no invented numbers.
export default function FbChannelPage() {
  const { go, toast } = useOmni();
  const { conn, canConnect, settings, setConn, saveSettings, error } = useConnection('meta-social');
  const [showSettings, setShowSettings] = useState(false);
  const ok = conn && conn.status === 'connected';
  const info = (ok && conn.info) || {};
  const set = settings && settings.facebook;
  const empty = (what) => (ok ? `${what} is not synced yet. This is planned.` : `Connect your Facebook Page to see ${what.toLowerCase()}.`);
  return (
    <div>
      <PageHead eyebrow="Channels" title="Facebook" lead="Manage Messenger conversations and monitor Page performance.">
        <Btn onClick={() => setShowSettings(true)}>Manage Page</Btn>
      </PageHead>
      <LoadError error={error} />
      <Metrics first>
        <Metric label="Page followers" value={ok && info.followers != null ? fmtNum(info.followers) : '—'} meta={ok && info.followers != null ? 'From Facebook when last checked' : (ok ? 'Not synced yet' : 'Connect to view')} tone={ok && info.followers != null ? 'up' : 'neutral'} dim={!ok} />
        <Metric label="Messenger conversations" value="—" meta={ok ? 'Not synced yet' : 'Connect to view'} dim={!ok} />
        <Metric label="Avg. response time" value="—" meta={ok ? 'Not synced yet' : 'Connect to view'} dim={!ok} />
      </Metrics>
      <div style={{ marginTop: 16 }}>
        <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} title="Connected Page" connectLabel="Connect Facebook Page"
          sub={ok ? (info.pageName || 'Facebook Page') : 'No Page connected yet'}
          info={[['Page', info.pageName], ['Followers', info.followers != null ? fmtNum(info.followers) : ''], ['Token', info.tokenWords]]}>
          <div className="panel-top" style={{ marginTop: 14 }}>
            <div><div className="panel-title" style={{ fontSize: 11 }}>Auto-reply on Messenger</div><div className="panel-sub">Answers common questions instantly before handing off.</div></div>
            <Toggle on={set ? set.messengerAuto : true} disabled={!canConnect || !set} label="Auto-reply on Messenger" title={canConnect ? '' : 'Only an Admin can change this'}
              onChange={async (v) => { try { await saveSettings('facebook', { messengerAuto: v }); toast(v ? 'Messenger auto-reply enabled' : 'Messenger auto-reply disabled'); } catch { toast('That could not be saved.'); } }} />
          </div>
          <Planned>Your choice is saved, but Messenger auto-reply is planned: nothing is answered automatically yet.</Planned>
        </ConnectionCard>
      </div>
      <Panel title="Messenger" sub="Conversations waiting on your Page." right={<Btn onClick={() => go('inbox')}>Open inbox →</Btn>} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Person', 'Last message', 'Waiting', 'Status']} rows={[]} empty={empty('Messenger conversations')} />
      </Panel>
      <Panel title="Recent Page posts" sub="Organic reach and engagement for the last five posts." right={<Btn onClick={() => go('social')}>Compose a post →</Btn>} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Post', 'Reach', 'Engagements', 'Published']} rows={[]} empty={empty('Page posts')} />
      </Panel>
      {showSettings && <ChannelSettingsModal channel="facebook" settings={settings} defaultName={info.pageName} canChange={canConnect} saveSettings={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
