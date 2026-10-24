import { useState } from 'react';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Panel, Planned, fmtNum } from '../ui.jsx';
import ConnectionCard from '../external/ConnectionCard.jsx';
import ChannelSettingsModal from '../external/ChannelSettingsModal.jsx';
import { Metric, Metrics, Toggle, SimpleTable, LoadError } from '../external/parts.jsx';
import { useConnection } from '../external/useExternal.js';

// Instagram channel hub (prototype page igchannel). Same Meta connection as the Facebook page (one set of keys); this page shows the Instagram part.
export default function IgChannelPage() {
  const { go, toast } = useOmni();
  const { conn, canConnect, settings, setConn, saveSettings, error } = useConnection('meta-social');
  const [showSettings, setShowSettings] = useState(false);
  const metaOk = conn && conn.status === 'connected';
  const info = (metaOk && conn.info) || {};
  const ok = !!(metaOk && info.igUsername);
  const set = settings && settings.instagram;
  const pill = metaOk && !ok ? { tone: 'warn', words: 'No Instagram account added' } : undefined;
  const empty = (what) => (ok ? `${what} is not synced yet. This is planned.` : `Connect your Instagram account to see ${what.toLowerCase()}.`);
  return (
    <div>
      <PageHead eyebrow="Channels" title="Instagram" lead="Manage Direct Messages and monitor account growth.">
        <Btn onClick={() => setShowSettings(true)}>Manage Account</Btn>
      </PageHead>
      <LoadError error={error} />
      <Metrics first>
        <Metric label="Followers" value={ok && info.igFollowers != null ? fmtNum(info.igFollowers) : '—'} meta={ok && info.igFollowers != null ? 'From Instagram when last checked' : (ok ? 'Not synced yet' : 'Connect to view')} tone={ok && info.igFollowers != null ? 'up' : 'neutral'} dim={!ok} />
        <Metric label="DMs received" value="—" meta={ok ? 'Not synced yet' : 'Connect to view'} dim={!ok} />
        <Metric label="Story mentions" value="—" meta={ok ? 'Not synced yet' : 'Connect to view'} dim={!ok} />
      </Metrics>
      <div style={{ marginTop: 16 }}>
        <ConnectionCard conn={conn} canConnect={canConnect} onChanged={setConn} title="Connected account" connectLabel="Connect Instagram account" pill={pill}
          sub={ok ? `@${info.igUsername}` : 'No Instagram account connected yet'}
          lead={metaOk && !ok ? 'Your Facebook Page is connected, but no Instagram business account ID was added. Press "Change keys" and add the Instagram business account ID.' : undefined}
          info={[['Account', info.igUsername ? `@${info.igUsername}` : ''], ['Followers', info.igFollowers != null ? fmtNum(info.igFollowers) : ''], ['Posts', info.igMedia != null ? fmtNum(info.igMedia) : '']]}>
          <div className="panel-top" style={{ marginTop: 14 }}>
            <div><div className="panel-title" style={{ fontSize: 11 }}>Auto-reply to Story mentions</div><div className="panel-sub">Sends a thank-you DM whenever someone mentions your Page in a Story.</div></div>
            <Toggle on={set ? set.storyAuto : false} disabled={!canConnect || !set} label="Auto-reply to Story mentions" title={canConnect ? '' : 'Only an Admin can change this'}
              onChange={async (v) => { try { await saveSettings('instagram', { storyAuto: v }); toast(v ? 'Story auto-reply enabled' : 'Story auto-reply disabled'); } catch { toast('That could not be saved.'); } }} />
          </div>
          <Planned>Your choice is saved, but the Story auto-reply is planned: no message is sent automatically yet.</Planned>
        </ConnectionCard>
      </div>
      <Panel title="Direct messages" sub="Conversations from your Instagram account." right={<Btn onClick={() => go('inbox')}>Open inbox →</Btn>} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Account', 'Last message', 'Waiting', 'Status']} rows={[]} empty={empty('Direct messages')} />
      </Panel>
      <Panel title="Recent content" sub="Reach and engagement by post." right={<Btn onClick={() => go('social')}>Compose a post →</Btn>} style={{ marginTop: 16 }}>
        <SimpleTable columns={['Post', 'Reach', 'Engagements', 'Published']} rows={[]} empty={empty('Instagram content')} />
      </Panel>
      {showSettings && <ChannelSettingsModal channel="instagram" settings={settings} defaultName={info.igUsername ? `@${info.igUsername}` : ''} canChange={canConnect} saveSettings={saveSettings} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
