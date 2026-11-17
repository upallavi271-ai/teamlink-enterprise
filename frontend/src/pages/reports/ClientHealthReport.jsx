import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import StatCard, { StatRow } from '../../components/ui/StatCard.jsx';
import {
  AutoSwitch, ComplaintsPanel, DateRange, Downloads, NpsTable, NpsTiles, Picker, SurveysList, errText,
} from './ExperienceBits.jsx';

// ---------------------------------------------------------------------------
// Reports & Team -> Reports -> "Client health" (backend routes/atsExperience.js):
//   Client NPS          after each joining + once a quarter, 0-10 + comment; by client, BDE and month
//   Escalations         client complaints / escalations (client portal or BDE), with level and status
//   Escalation matrix   per client: level 1 -> 2 -> 3, who in our team and after how many hours
//   Retention           active / retained / churned by month, joinings and invoices by client, lost clients with the last reason
// ---------------------------------------------------------------------------
const PARTS = [['nps', 'Client NPS'], ['escalations', 'Escalations'], ['matrix', 'Escalation matrix'], ['retention', 'Retention & lost clients'], ['surveys', 'Surveys sent']];
const yearAgo = () => new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => (n === null || n === undefined ? '—' : `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`);

function ClientNps() {
  const [r, setR] = useState({ from: yearAgo(), to: today() });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [auto, setAuto] = useState(null);
  const load = useCallback(() => { api.get('/ats-experience/client-nps', { params: r }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the report.'))); }, [r]);
  useEffect(load, [load]);
  useEffect(() => { api.get('/ats-experience/client-surveys/settings').then((x) => setAuto(x.data)).catch(() => setAuto(null)); }, []);
  async function sendQuarter() {
    if (!window.confirm(`Send this quarter's (${d.quarter}) survey to every active client's contact? A client already sent one this quarter is skipped.`)) return;
    try { const x = await api.post('/ats-experience/client-surveys/quarterly', {}); setMsg(`${x.data.created} sent, ${x.data.already} already had this quarter's survey${x.data.skipped ? `, ${x.data.skipped} skipped` : ''}.`); load(); } catch (e) { setErr(errText(e, 'Could not send.')); }
  }
  async function toggleAuto(on) {
    try { const x = await api.put('/ats-experience/client-surveys/settings', { autoQuarterly: on }); setAuto({ ...auto, autoQuarterly: x.data.autoQuarterly }); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <DateRange value={r} onChange={setR} />
        <span style={{ flex: 1 }} />
        {d && d.maySendQuarterly && <button type="button" className="btn btn-sm btn-primary" onClick={sendQuarter}>Send {d.quarter} survey</button>}
        <Downloads name="client-nps" params={r} onError={setErr} />
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      {msg && <div className="notice green"><span>{msg}</span></div>}
      <p className="small-muted" style={{ margin: '0 0 10px' }}>The client contact gets &quot;How likely are you to recommend TeamLink?&quot; (0-10 + a comment) after each joining and once a quarter.
        {auto && auto.mayEdit && (
          <label style={{ marginLeft: 8 }}><input type="checkbox" checked={!!auto.autoQuarterly} onChange={(e) => toggleAuto(e.target.checked)} /> Send the quarterly survey by itself in the first days of each quarter</label>
        )}
      </p>
      {!d ? <div className="small-muted">Loading…</div> : (
        <>
          <NpsTiles o={d.overall} stars={false} />
          <NpsTable title="By client" first="Client" rows={d.byClient} stars={false} />
          <NpsTable title="By BDE" first="BDE" rows={d.byBde} stars={false} />
          <NpsTable title="By month" first="Month" rows={d.byMonth} stars={false} />
          <NpsTable title="After a joining / quarterly" first="Survey" rows={d.byKind} stars={false} />
        </>
      )}
    </div>
  );
}

function Matrix() {
  const [clientId, setClientId] = useState('');
  const [m, setM] = useState(null);
  const [people, setPeople] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/ats-experience/pick/people').then((x) => setPeople(x.data.rows || [])).catch(() => setPeople([])); }, []);
  useEffect(() => {
    if (!clientId) { setM(null); return; }
    api.get(`/ats-experience/escalation-matrix/${clientId}`).then((x) => { setM(x.data); setErr(''); setMsg(''); }).catch((e) => setErr(errText(e, 'Could not load the matrix.')));
  }, [clientId]);
  const setLevel = (n, k, v) => setM({ ...m, levels: m.levels.map((l) => (l.level === n ? { ...l, [k]: v } : l)) });
  async function save() {
    try { const x = await api.put(`/ats-experience/escalation-matrix/${clientId}`, { levels: m.levels.map((l) => ({ level: l.level, userId: l.userId || null, hours: Number(l.hours) })) }); setM(x.data); setMsg('Saved. New escalations of this client follow it.'); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  const WHO = ['Level 1 (usually the recruiter)', 'Level 2 (usually the team lead)', 'Level 3 (BDE TL / manager)'];
  return (
    <div>
      <p className="small-muted" style={{ margin: '0 0 10px' }}>Who handles a client&apos;s escalation, and for how many hours, before it goes up one level. Not set = the client&apos;s latest job&apos;s recruiter (24 h) → its TL (24 h) → the BDE TL (48 h).</p>
      <div style={{ maxWidth: 420, marginBottom: 12 }}><Picker kind="clients" value={clientId} onPick={(id) => setClientId(id)} /></div>
      {err && <div className="notice red"><span>{err}</span></div>}
      {msg && <div className="notice green"><span>{msg}</span></div>}
      {m && (
        <div className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>{m.client}</h3>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Level</th><th>Person</th><th className="num">Hours at this level</th></tr></thead>
              <tbody>
                {m.levels.map((l) => (
                  <tr key={l.level}>
                    <td>{WHO[l.level - 1]}</td>
                    <td>{m.mayEdit ? (
                      <select value={l.userId || ''} onChange={(e) => setLevel(l.level, 'userId', e.target.value)}>
                        <option value="">Nobody named</option>
                        {l.userId && !people.some((p) => p.id === l.userId) && <option value={l.userId}>{l.name || l.userId}</option>}
                        {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.atsRole ? ` · ${p.atsRole}` : ''}</option>)}
                      </select>
                    ) : (l.name || 'Nobody named')}{l.fromDefault && <div className="small-muted">default</div>}</td>
                    <td className="num">{m.mayEdit ? <input type="number" min={1} max={720} value={l.hours} onChange={(e) => setLevel(l.level, 'hours', e.target.value)} style={{ width: 80 }} /> : l.hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {m.mayEdit ? <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 10 }} onClick={save}>Save matrix</button> : <p className="small-muted">Only Admin, a Manager or the BDE TL changes the matrix.</p>}
          {m.updatedAt && <p className="small-muted" style={{ marginTop: 8 }}>Last saved by {m.updatedByName || '—'}.</p>}
        </div>
      )}
    </div>
  );
}

function Retention() {
  const [months, setMonths] = useState(6);
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [marking, setMarking] = useState(null);
  const [form, setForm] = useState({ reason: '', notes: '' });
  const load = useCallback(() => { api.get('/ats-experience/retention', { params: { months } }).then((x) => { setD(x.data); setErr(''); }).catch((e) => setErr(errText(e, 'Could not load the report.'))); }, [months]);
  useEffect(load, [load]);
  async function mark() {
    try { await api.post(`/ats-experience/clients/${marking.clientId}/lost`, form); setMarking(null); setForm({ reason: '', notes: '' }); load(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  async function unmark(c) {
    try { await api.delete(`/ats-experience/clients/${c.clientId}/lost`); load(); } catch (e) { setErr(errText(e, 'Could not save.')); }
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <label className="small-muted">Months <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[3, 6, 12, 24].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <span style={{ flex: 1 }} />
        <Downloads name="retention" params={{ months }} onError={setErr} />
      </div>
      {err && <div className="notice red"><span>{err}</span></div>}
      <p className="small-muted" style={{ margin: '0 0 10px' }}>Active = an open requirement, or a joining in the last 90 days, at the month end. Retained = active last month and this month; churned = active last month, not this month. Lost = no activity for 90+ days, or marked lost.</p>
      {!d ? <div className="small-muted">Loading…</div> : (
        <>
          <StatRow>
            <StatCard label="Active clients now" value={d.overall.activeNow} />
            <StatCard label="Retention this month" value={d.overall.retentionPct === null ? null : `${d.overall.retentionPct}%`} />
            <StatCard label="Churned this month" value={d.overall.churnedThisMonth} tone="red" upIsGood={false} zeroText="None" />
            <StatCard label="Lost clients" value={d.overall.lost} tone="red" upIsGood={false} zeroText="None" />
          </StatRow>
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>By month</h3>
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Month</th><th className="num">Active at start</th><th className="num">Active at end</th><th className="num">Retained</th><th className="num">Churned</th><th className="num">New</th><th className="num">Retention</th><th className="num">Joinings</th>{d.money && <th className="num">Invoiced</th>}</tr></thead>
                <tbody>{d.byMonth.map((m) => <tr key={m.key}><td>{m.label}</td><td className="num">{m.activeAtStart}</td><td className="num">{m.active}</td><td className="num">{m.retained}</td><td className="num">{m.churned}</td><td className="num">{m.new}</td><td className="num"><b>{m.retentionPct === null ? '—' : `${m.retentionPct}%`}</b></td><td className="num">{m.joinings}</td>{d.money && <td className="num">{money(m.revenue)}</td>}</tr>)}</tbody>
              </table>
            </div>
          </section>
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Lost clients ({d.lost.length})</h3>
            {marking && (
              <div className="card" style={{ marginBottom: 10, display: 'grid', gap: 8, maxWidth: 560 }}>
                <b>Mark {marking.client} as lost</b>
                <input placeholder="Why was the client lost? (needed)" maxLength={300} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                <textarea placeholder="Notes (optional)" rows={2} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                <div style={{ display: 'flex', gap: 6 }}><button type="button" className="btn btn-sm btn-primary" disabled={!form.reason.trim()} onClick={mark}>Mark lost</button><button type="button" className="btn btn-sm" onClick={() => setMarking(null)}>Cancel</button></div>
              </div>
            )}
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Client</th><th>BDE</th><th>Why lost</th><th>Last activity</th><th className="num">Days idle</th><th>Last reason / notes</th><th /></tr></thead>
                <tbody>
                  {d.lost.map((c) => <tr key={c.clientId}><td>{c.client}</td><td>{c.bde}</td><td>{c.state}{c.markedLostOn ? <div className="small-muted">{c.markedLostOn} · {c.markedBy}</div> : null}</td><td>{c.lastActivity || '—'}</td><td className="num">{c.daysIdle ?? '—'}</td><td>{c.reason}{c.notes ? <div className="small-muted">{c.notes}</div> : null}</td><td>{c.markedLostOn ? <button type="button" className="btn btn-sm" onClick={() => unmark(c)}>Not lost</button> : <button type="button" className="btn btn-sm" onClick={() => setMarking(c)}>Add reason</button>}</td></tr>)}
                  {!d.lost.length && <tr><td colSpan={7} className="small-muted">No lost clients.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <section style={{ marginTop: 16 }}>
            <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>All clients</h3>
            <div className="tbl-wrap tbl-fit">
              <table>
                <thead><tr><th>Client</th><th>BDE</th><th>State</th><th className="num">Open requirements</th><th className="num">Joinings ({d.months} months)</th>{d.money && <th className="num">Invoiced ({d.months} months)</th>}<th>Last activity</th><th /></tr></thead>
                <tbody>
                  {d.clients.map((c) => <tr key={c.clientId}><td>{c.client}</td><td>{c.bde}</td><td>{c.state}</td><td className="num">{c.openRequirements}</td><td className="num">{c.joinings}</td>{d.money && <td className="num">{money(c.revenue)}</td>}<td>{c.lastActivity || '—'}</td><td>{c.state !== 'Lost (marked)' && <button type="button" className="btn btn-sm" onClick={() => setMarking(c)}>Mark lost</button>}</td></tr>)}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function ClientHealthReport() {
  const [part, setPart] = useState('nps');
  return (
    <div>
      <AutoSwitch which="clientSurveys" />
      <div className="tabs" role="tablist" aria-label="Client health">
        {PARTS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={part === id} className={`tab-btn${part === id ? ' active' : ''}`} onClick={() => setPart(id)}>{label}</button>
        ))}
      </div>
      {part === 'nps' && <ClientNps />}
      {part === 'escalations' && <ComplaintsPanel side="client" />}
      {part === 'matrix' && <Matrix />}
      {part === 'retention' && <Retention />}
      {part === 'surveys' && <SurveysList side="client" />}
    </div>
  );
}
