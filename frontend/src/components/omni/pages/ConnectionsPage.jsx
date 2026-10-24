import { useCallback, useEffect, useState } from 'react';
import { shared, errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { Banner, Btn, Kpi, Kpis, PageHead, Panel, Pill, fmtDateTime, fmtNum } from '../ui.jsx';
import '../library/library.css';

// CHANNEL CONNECTIONS > Connection status: one card per channel with the HONEST state (Connected / Test mode / Not set up / Planned) and the plain reason from the real
// check; whether replies can reach us; and Sync health (provider events that failed or wait, replies in Needs review, failed campaign messages, duplicates ignored).
// No key, token or password is ever shown here. Server: GET /api/omni/connections, GET /api/omni/sync-health, POST /api/omni/replies/retry (Admin).
const TONE = { connected: ['live', 'Connected'], test: ['warn', 'Test mode'], not_set_up: ['red', 'Not set up'], planned: ['draft', 'Planned'] };

export default function ConnectionsPage() {
  const { go, toast, acc } = useOmni();
  const [c, setC] = useState(null);
  const [h, setH] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    shared.get('/connections').then(setC).catch((e) => setErr(errOf(e, 'The channels could not be checked.')));
    shared.get('/sync-health').then(setH).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const retry = async () => {
    setBusy(true);
    try { const r = await shared.post('/replies/retry'); toast(`Tried ${r.tried || 0}: ${r.ok || 0} done, ${r.failedAgain || 0} failed again`); load(); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); }
  };
  const ev = h && h.events;
  return (
    <div>
      <PageHead eyebrow="What is really connected" title="Channel Connections" lead="Each channel says plainly whether it is set up and whether messages really go out. Nothing here is shown as working unless it is.">
        <Btn onClick={load}>Check again</Btn>
        {acc && acc.isAdmin && <Btn onClick={() => go('settings')}>Open Settings</Btn>}
      </PageHead>
      {err && <Banner tone="error">{err}</Banner>}
      {c && <Banner tone={c.rehearsal ? 'test' : 'ok'}>{c.rehearsal ? (c.sendingOn ? 'Test mode is ON: every campaign is only a rehearsal and nothing is sent to anybody.' : '"Outreach sending" is switched OFF: nothing is sent to anybody.') : 'Sending is ON: real messages go out on the channels marked Connected.'}</Banner>}
      <div className="conn-grid">
        {!c ? <div className="card panel">Loading…</div> : c.channels.map((ch) => {
          const [tone, word] = TONE[ch.state] || ['draft', ch.state];
          return (
            <div className="card conn-card" key={ch.id}>
              <h3>{ch.name}<Pill tone={tone} dot>{word}</Pill></h3>
              <p>{ch.words}</p>
              {ch.reason && <p style={{ color: '#9b1c1c' }}><b>Why:</b> {ch.reason}</p>}
              {ch.fix && <p className="lib-sub">{ch.fix}</p>}
              {ch.state !== 'planned' && <p><b>Replies:</b> {ch.inbound.words}{ch.inbound.lastAt ? ` Last call: ${fmtDateTime(ch.inbound.lastAt)}.` : ''}</p>}
            </div>
          );
        })}
      </div>
      <Panel title="Sync health" sub="Replies and delivery reports that come from the providers, and what happened to them." right={h && <Pill tone={h.state === 'ok' ? 'live' : 'warn'} dot>{h.words}</Pill>}>
        {!h ? 'Loading…' : (
          <>
            <Kpis>
              <Kpi label="Provider events" icon="⇅" value={fmtNum(ev.total)} meta={`${fmtNum(ev.routed)} matched and delivered to their record`} />
              <Kpi label="Failed (will retry)" icon="!" value={fmtNum(ev.failed)} tone={ev.failed ? 'down' : undefined} meta={ev.failed ? 'Tried again by itself' : 'None'} />
              <Kpi label="Waiting" icon="…" value={fmtNum(ev.pending)} meta="Being handled right now" />
              <Kpi label="Needs review" icon="?" value={fmtNum(ev.needsReview)} meta="Open Inbox & Replies > Needs review" onClick={() => go('review')} />
              <Kpi label="Duplicates ignored" icon="⧉" value={fmtNum(ev.duplicatesIgnored)} meta="The same event sent twice by the provider" />
            </Kpis>
            <p className="lib-sub" style={{ marginTop: 8 }}>Campaign messages: {fmtNum(h.campaignMessages.failed)} failed, {fmtNum(h.campaignMessages.waiting)} waiting. From the app screens: {fmtNum(h.appCampaignMessages.failed)} failed.</p>
            {ev.failedList.length > 0 && (
              <div className="table-scroll" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead><tr><th>When</th><th>Where from</th><th>What went wrong</th><th>Tries</th><th>Next try</th></tr></thead>
                  <tbody>{ev.failedList.map((f) => <tr key={f.id}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(f.at)}</td><td>{f.channel || f.provider}</td><td>{f.error || '—'}</td><td>{f.attempts}</td><td>{f.giveUp ? 'Gave up' : (f.nextTry ? fmtDateTime(f.nextTry) : 'Soon')}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            {h.canRetry && ev.failed > 0 && <div style={{ marginTop: 10 }}><Btn primary disabled={busy} onClick={retry}>Try the failed ones again now</Btn></div>}
          </>
        )}
      </Panel>
    </div>
  );
}
