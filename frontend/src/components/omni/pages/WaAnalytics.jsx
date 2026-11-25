import { useCallback, useEffect, useState } from 'react';
import api from '../../../api';
import { Panel, Kpi, Kpis, Tabs, Banner, Empty, Pill, fmtNum, fmtDateTime } from '../ui.jsx';
import { errOf } from '../omniApi.js';

// ---------------------------------------------------------------------------
// WHATSAPP > ANALYTICS (the AI WhatsApp Marketing Assistant): real numbers only. Every figure is counted from messages, chats, leads and campaigns that exist; one that cannot be known is a
// dash, never a zero or a guess (no percentage without something to divide, no response time without a customer who was answered). Server: GET /api/omni-wa/analytics?days=7|30|90.
// ---------------------------------------------------------------------------
const BASE = '/omni-wa';
const dash = '—';
const num = (v) => (v === null || v === undefined ? dash : fmtNum(v));
const pc = (v) => (v === null || v === undefined ? dash : `${v}%`);
function span(ms) {
  if (ms === null || ms === undefined) return dash;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
const KIND = [['assistant', 'Answers by the assistant'], ['followUp', 'Follow-ups'], ['campaign', 'Campaign messages'], ['team', 'Replies typed by your team']];

export default function WaAnalytics() {
  const [days, setDays] = useState('30');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setD(null); return api.get(`${BASE}/analytics`, { params: { days } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The analytics could not be loaded.'))); }, [days]);
  useEffect(() => { load(); }, [load]);
  const tabs = <Tabs tabs={[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']]} value={days} onChange={setDays} />;
  if (err) return <>{tabs}<Banner tone="warn">{err}</Banner></>;
  if (!d) return <>{tabs}<div className="small-muted">Loading…</div></>;
  const m = d.messages; const e = d.enquiries; const r = d.responseTime; const l = d.leads; const h = d.handover; const o = d.optOuts; const c = d.campaigns;
  return (
    <>
      {tabs}
      <p className="small-muted">Only numbers that really happened. A dash means there is nothing to count it from yet: nothing is estimated.</p>
      {d.empty && <Empty title="Nothing to count yet">{d.marketingNumbers ? 'No message, new chat or campaign in this period on a marketing number.' : 'No WhatsApp number is marked as a marketing number yet. Mark one in Settings > WhatsApp AI > Marketing assistant.'}</Empty>}
      <Panel title="Messages sent" sub="On marketing numbers, and every campaign message">
        <Kpis>
          <Kpi label="Sent" icon="➤" value={num(m.sent)} meta={m.awaitingReport ? `${m.awaitingReport} with no report from Meta yet` : null} />
          <Kpi label="Delivered" icon="✓" value={num(m.delivered)} meta={m.deliveredPct === null ? null : `${m.deliveredPct}% of sent`} />
          <Kpi label="Read" icon="✓✓" value={num(m.read)} meta={m.readPct === null ? null : `${m.readPct}% of sent (only people whose WhatsApp sends read receipts)`} />
          <Kpi label="Failed" icon="!" value={num(m.failed)} tone={m.failed ? 'warn' : 'neutral'} meta={m.failedPct === null ? null : `${m.failedPct}% of sent`} />
        </Kpis>
        <div className="small-muted" aria-label="Messages by kind" style={{ marginTop: 8 }}>{KIND.map(([k, w]) => `${w}: ${num(m.byKind[k])}`).join(' · ')}</div>
      </Panel>
      <Panel title="Enquiries" sub="Customers who wrote to a marketing number">
        <Kpis>
          <Kpi label="New customers" icon="◎" value={num(e.newCustomers)} meta="chats that began in this period" />
          <Kpi label="Customers who wrote" icon="✉" value={num(e.customersWhoWrote)} />
          <Kpi label="Messages received" icon="↙" value={num(e.messagesReceived)} />
        </Kpis>
      </Panel>
      <Panel title="Response time" sub="From a customer's message to the first answer. A follow-up or a campaign is not an answer.">
        <Kpis>
          <Kpi label="Assistant, typical" icon="⚡" value={span(r.assistant.medianMs)} meta={r.assistant.answered ? `average ${span(r.assistant.meanMs)} · ${r.assistant.answered} answered` : 'nobody answered by the assistant yet'} />
          <Kpi label="Your team, typical" icon="☺" value={span(r.team.medianMs)} meta={r.team.answered ? `average ${span(r.team.meanMs)} · ${r.team.answered} answered` : 'no reply typed in this screen yet'} />
        </Kpis>
      </Panel>
      <Panel title="Leads" sub="Saved in the CRM by the assistant in this period">
        <Kpis>
          <Kpi label="Showed interest" icon="◐" value={num(l.asked)} />
          <Kpi label="Saved in the CRM" icon="◎" value={num(l.saved)} />
          <Kpi label="Qualified (Hot + Warm)" icon="▲" value={num(l.qualified)} tone={l.qualified ? 'warn' : 'neutral'} meta={`Hot ${l.Hot} · Warm ${l.Warm} · Cold ${l.Cold}${l.notScored ? ` · ${l.notScored} not scored` : ''}`} />
        </Kpis>
      </Panel>
      <Panel title="Hand-over" sub="What the assistant answered itself and what it passed to a person">
        <Kpis>
          <Kpi label="Answered by the assistant" icon="✓" value={num(h.answeredByAssistant)} />
          <Kpi label="Passed to a person" icon="☺" value={num(h.passedToAPerson)} meta={h.passedPct === null ? null : `${h.passedPct}% of the turns`} />
        </Kpis>
      </Panel>
      <Panel title="Opt-outs" sub="Customers who wrote STOP among those we were in touch with">
        <Kpis>
          <Kpi label="Opt-out rate" icon="⛔" value={pc(o.ratePct)} tone={o.optedOut ? 'warn' : 'neutral'} meta={o.customersContacted ? `${o.optedOut} of ${o.customersContacted} customers messaged` : 'no customer was messaged in this period'} />
        </Kpis>
      </Panel>
      <Panel title="Campaign performance" sub={`${c.count} campaign${c.count === 1 ? '' : 's'} made in this period`}>
        {c.count === 0 && <p className="small-muted">No campaign was made in this period.</p>}
        {c.count > 0 && (
          <>
            <div className="small-muted" aria-label="Campaign totals">All together: {num(c.totals.sent)} sent · {num(c.totals.delivered)} delivered ({pc(c.totals.deliveredPct)}) · {num(c.totals.read)} read ({pc(c.totals.readPct)}) · {num(c.totals.replied)} replied ({pc(c.totals.repliedPct)}) · {num(c.totals.optedOut)} opted out ({pc(c.totals.optedOutPct)}) · {num(c.totals.failed)} failed</div>
            <table style={{ width: '100%', marginTop: 8, borderCollapse: 'collapse' }}>
              <thead><tr style={{ textAlign: 'left' }}><th>Campaign</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Replied</th><th>Opted out</th><th>Failed</th></tr></thead>
              <tbody>
                {c.list.map((x) => (
                  <tr key={x.id} style={{ borderTop: '1px solid var(--line, #e5e7eb)' }}>
                    <td><b>{x.name}</b> <Pill>{x.status}</Pill><div className="small-muted">{fmtDateTime(x.createdAt)}</div></td>
                    <td>{num(x.sent)}</td><td>{num(x.delivered)} ({pc(x.deliveredPct)})</td><td>{num(x.read)} ({pc(x.readPct)})</td><td>{num(x.replied)} ({pc(x.repliedPct)})</td><td>{num(x.optedOut)} ({pc(x.optedOutPct)})</td><td>{num(x.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>
      <div className="small-muted" style={{ marginTop: 10 }}>{d.notes.map((t) => <div key={t}>{t}</div>)}</div>
    </>
  );
}
