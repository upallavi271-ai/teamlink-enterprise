import { useCallback, useEffect, useState } from 'react';
import { useOmni } from '../omniContext.js';
import omni, { errOf } from '../omniApi.js';
import { Banner, Btn, Empty, Kpi, Kpis, PageHead, Panel, Pill, TinyBtn, fmtDateTime, fmtNum } from '../ui.jsx';
import Toggle from '../automation/Toggle.jsx';
import '../automation/automation.css';

// ---------------------------------------------------------------------------
// WHATSAPP BOT DATA (prototype page "botdata"): "Monitor automated replies and hand off complex conversations to your team." Everything is made from the
// real bot flows and the real bot log (Bot Builder). The on / off switch of the "Auto-reply bot" panel is the Admin switch "Bot auto-replies":
// even with it ON the bot only answers for real when Test mode is off; otherwise the log says "Would have replied (Test mode)".
// Server: GET /api/outreach/gs/bots/data, GET / PUT /gs/bots/switch.
// ---------------------------------------------------------------------------
const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export default function BotDataPage() {
  const { go, toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { omni.get('/gs/bots/data').then((r) => { setD(r); setErr(''); }).catch((e) => setErr(errOf(e, 'Bot data could not be loaded.'))); }, []);
  useEffect(() => { load(); }, [load]);

  const head = (
    <PageHead eyebrow="Automated conversations" title="WhatsApp Bot Data" lead="Monitor automated replies and hand off complex conversations to your team.">
      <Btn onClick={() => go('botbuilder')}>Edit bot flow</Btn>
    </PageHead>
  );
  if (err && !d) return <div>{head}<Banner tone="error">{err}</Banner></div>;
  if (!d) return <div>{head}<div className="card panel">Loading…</div></div>;

  const flip = async (on) => {
    setBusy(true);
    try { const r = await omni.put('/gs/bots/switch', { enabled: on }); toast(on ? 'Auto-reply bot enabled' : 'Auto-reply bot disabled'); setD({ ...d, state: r.state }); } catch (e) { setErr(errOf(e, 'That did not work.')); } finally { setBusy(false); }
  };
  const k = d.kpis;
  return (
    <div>
      {head}
      {err && <Banner tone="error">{err}</Banner>}
      <Kpis>
        <Kpi label="Conversations handled" icon="◈" value={fmtNum(k.handled)} meta={k.rehearsed ? `This month · ${fmtNum(k.rehearsed)} more only rehearsed` : 'This month'} tone={k.handled ? 'up' : undefined} />
        <Kpi label="Auto-resolved" icon="✓" value={pctText(k.resolvedPct)} meta={k.handled ? 'No agent needed' : 'No bot conversations yet'} tone={k.handled ? 'up' : undefined} />
        <Kpi label="Handed off to agent" icon="↗" value={pctText(k.handoffPct)} meta="Routed to WhatsApp Inbox" />
      </Kpis>

      <Panel title="Auto-reply bot" sub="Instantly answers common questions before routing to a human agent."
        right={d.canSwitch
          ? <div className="au-row"><span className="au-sub">{d.state.switchOn ? 'On' : 'Off'}</span><Toggle on={d.state.switchOn} disabled={busy} label="Bot auto-replies" title="Admin switch: Bot auto-replies" onChange={flip} /></div>
          : <Pill tone={d.state.switchOn ? 'live' : 'draft'} dot>{d.state.switchOn ? 'On' : 'Off'} (Admin switch)</Pill>}>
        <Banner tone={d.state.live ? 'info' : 'test'}>{d.state.words}</Banner>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Trigger phrase</th><th>Auto-reply</th><th>Uses this month</th><th>Status</th></tr></thead>
            <tbody>
              {d.rules.length === 0 && <tr><td colSpan={4}><Empty title="No bot flows yet" action={d.canManage ? <Btn primary onClick={() => go('botbuilder')}>Make a bot flow</Btn> : null}>Flows you make in Bot Builder show here with how often they were used.</Empty></td></tr>}
              {d.rules.map((r) => (
                <tr key={r.id}>
                  <td className="au-wrap">{r.phrases.map((p) => `"${p}"`).join(', ')}{r.matchMode === 'exact' ? <div className="au-sub">Exact message only</div> : null}</td>
                  <td className="au-wrap">{r.reply}</td>
                  <td>{fmtNum(r.uses)}</td>
                  <td><Pill tone={r.status === 'on' ? 'live' : 'draft'} dot>{r.statusWords}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recent bot sessions" sub="What the bot handled, and what it handed over." right={<Btn onClick={() => go('botbuilder')}>Edit bot flow →</Btn>} style={{ marginTop: 16 }}>
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Customer</th><th>Intent</th><th>Turns</th><th>Outcome</th><th>When</th><th /></tr></thead>
            <tbody>
              {d.sessions.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: '26px 0' }}>Nothing here yet.</td></tr>}
              {d.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="au-wrap"><b>{s.name}</b></td>
                  <td className="au-wrap">{s.intent ? `"${s.intent}"` : '—'}<div className="au-sub">{s.flow}</div></td>
                  <td>{s.turns}</td>
                  <td><Pill tone={s.tone}>{s.outcomeWords}</Pill>{s.reason ? <div className="au-sub au-wrap">{s.reason}</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(s.at)}</td>
                  <td><TinyBtn onClick={() => go('inbox')}>Open</TinyBtn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {d.waiting.length > 0 && (
        <Panel title="Waiting for a person" sub="The bot passed these chats to their owner in the last 3 days. Open the WhatsApp Inbox to reply." style={{ marginTop: 16 }}>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Customer</th><th>Flow</th><th>When</th><th /></tr></thead>
              <tbody>{d.waiting.map((w) => <tr key={w.id}><td className="au-wrap"><b>{w.name}</b></td><td className="au-wrap">{w.flow}</td><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(w.at)}</td><td><TinyBtn onClick={() => go('inbox')}>Open Inbox</TinyBtn></td></tr>)}</tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
