import { useCallback, useEffect, useState } from 'react';
import omni, { errOf } from '../omniApi.js';
import { useOmni } from '../omniContext.js';
import { PageHead, Btn, Kpi, Kpis, Panel, Pill, Banner, Field, fmtNum, fmtDateTime } from '../ui.jsx';
import { AiBanner, aiLabel } from '../marketing/mk.jsx';

// AI MARKETING > AI USAGE: every AI request (who, which module, which model, how big, how long), the limits, and which AI parts are connected.
const SLOT = { text: 'Text', image: 'Images', video: 'Videos', audio: 'Audio' };
const TASK = { draft: 'Wrote versions', revise: 'Rewrote one message' };
export default function MkUsagePage() {
  const { toast } = useOmni();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [lim, setLim] = useState({ aiDailyPerUser: 60, aiMonthlyCap: 0, selfApprove: true });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => omni.get('/gs/marketing/usage').then((x) => { setD(x); setLim({ aiDailyPerUser: x.settings.aiDailyPerUser, aiMonthlyCap: x.settings.aiMonthlyCap, selfApprove: x.settings.selfApprove }); }).catch((e) => setErr(errOf(e, 'The usage could not be read.'))), []);
  useEffect(() => { load(); }, [load]);
  if (err && !d) return <Banner tone="error">{err}</Banner>;
  if (!d) return <div className="card panel">Loading…</div>;
  const s = d.summary;
  const save = async () => {
    setBusy(true);
    try { const r = await omni.put('/gs/marketing/settings', lim); toast(r.ok || 'Saved'); await load(); } catch (e) { toast(errOf(e, 'It could not be saved.')); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHead eyebrow="AI Marketing" title="AI usage" lead={d.scope === 'all' ? 'Every AI request made in AI Marketing, by everybody.' : 'Your own AI requests. An Admin sees everybody\'s.'} />
      <AiBanner ai={d.ai} />
      <Kpis>
        <Kpi label="This month" icon="✧" value={fmtNum(s.month)} meta="AI requests that worked" />
        <Kpi label="Today" icon="◔" value={fmtNum(s.today)} meta={`Limit ${d.settings.aiDailyPerUser} per person a day`} />
        <Kpi label="Failed this month" icon="!" value={fmtNum(s.failed)} tone={s.failed > 0 ? 'warn' : 'neutral'} meta="Not ready, over a limit, or unreadable" />
        <Kpi label="Company limit" icon="∑" value={d.settings.aiMonthlyCap ? fmtNum(d.settings.aiMonthlyCap) : 'None'} meta="AI requests a month" />
      </Kpis>
      <Panel title="What is connected" sub="The shared AI layer has one slot per kind of AI. Only text is built so far; images, videos and audio are on the menu for later." style={{ marginTop: 14 }}>
        <div className="mk-prov">
          {Object.keys(SLOT).map((k) => { const a = d.ai[k] || {}; return (
            <div key={k}><b>{SLOT[k]} {a.ready ? <Pill tone={a.demo ? 'warn' : 'live'} dot>{a.demo ? 'Sample writer' : 'Ready'}</Pill> : <Pill tone="draft">Not connected</Pill>}</b>
              <span>{a.ready ? aiLabel(a) : (a.reason || 'Not connected yet.')}</span></div>
          ); })}
        </div>
      </Panel>
      {d.canEdit && (
        <Panel title="Limits" sub="Stop one person, or the whole company, from using too much AI." style={{ marginTop: 14 }} right={<Btn primary disabled={busy} onClick={save}>Save limits</Btn>}>
          <div className="form-grid">
            <Field label="AI REQUESTS PER PERSON PER DAY" hint="0 switches AI off for everybody."><input type="number" min="0" max="2000" value={lim.aiDailyPerUser} onChange={(e) => setLim({ ...lim, aiDailyPerUser: e.target.value })} /></Field>
            <Field label="COMPANY LIMIT PER MONTH" hint="0 = no company limit."><input type="number" min="0" value={lim.aiMonthlyCap} onChange={(e) => setLim({ ...lim, aiMonthlyCap: e.target.value })} /></Field>
            <Field label="AN ADMIN MAY APPROVE THEIR OWN CONTENT" full hint="On: an Admin who wrote something can approve it (it is recorded as self-approved). Off: another approver has to."><select value={lim.selfApprove ? 'yes' : 'no'} onChange={(e) => setLim({ ...lim, selfApprove: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select></Field>
          </div>
        </Panel>
      )}
      <div className="mk-two" style={{ marginTop: 14, gridTemplateColumns: d.scope === 'all' ? undefined : '1fr' }}>
        <Panel title="By task this month">
          {s.byModule.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No AI requests yet this month.</div> : (
            <table className="mk-table"><thead><tr><th>MODULE</th><th>TASK</th><th className="num">REQUESTS</th></tr></thead><tbody>{s.byModule.map((r) => <tr key={`${r.module}${r.task}`}><td>{r.module === 'content' ? 'AI Content' : r.module}</td><td>{TASK[r.task] || r.task}</td><td className="num">{fmtNum(r.calls)}</td></tr>)}</tbody></table>
          )}
        </Panel>
        {d.scope === 'all' && (
          <Panel title="By person this month">
            {s.byPerson.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>Nobody yet.</div> : (
              <table className="mk-table"><thead><tr><th>PERSON</th><th className="num">REQUESTS</th></tr></thead><tbody>{s.byPerson.map((r) => <tr key={r.userId || r.name}><td>{r.name}</td><td className="num">{fmtNum(r.calls)}</td></tr>)}</tbody></table>
            )}
          </Panel>
        )}
      </div>
      <Panel title="Recent requests" sub="The last 50. Only sizes and times are kept here, not the words." style={{ marginTop: 14 }}>
        {d.recent.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No requests yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="mk-table"><thead><tr><th>WHEN</th><th>WHO</th><th>TASK</th><th>AI</th><th className="num">SIZE</th><th className="num">TIME</th><th>RESULT</th></tr></thead>
              <tbody>{d.recent.map((r) => (
                <tr key={r.id}><td>{fmtDateTime(r.at)}</td><td>{r.userName}</td><td>{TASK[r.task] || r.task}</td><td>{r.provider === 'demo' ? 'Sample writer' : `${r.provider}${r.model ? ` · ${r.model}` : ''}`}</td><td className="num">{fmtNum(r.chars)}</td><td className="num">{r.ms} ms</td><td>{r.ok ? <Pill tone="live" dot>Worked</Pill> : <span title={r.error}><Pill tone="red" dot>Failed</Pill> <small>{r.error}</small></span>}</td></tr>
              ))}</tbody></table>
          </div>
        )}
      </Panel>
    </div>
  );
}
