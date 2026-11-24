import { useEffect, useState } from 'react';
import api from '../../api';

// ViciDial (office dialer), Administration > Integrations > Connections (2026-11-24). "Click to dial": when it is On, a recruiter with a ViciDial
// agent ID picks "ViciDial" in "Call using" and presses Call; their browser (on the office LAN) asks the office ViciDial to dial on their own agent
// screen. This server never contacts ViciDial. The API password is stored encrypted and never shown again.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

function AgentRow({ p, onSaved }) {
  const [v, setV] = useState(p.agentUser || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { setV(p.agentUser || ''); }, [p.agentUser]);
  const save = async () => {
    setBusy(true); setMsg('');
    try { const r = await api.put(`/browser-calling/vicidial/admin/agents/${encodeURIComponent(p.userId)}`, { agentUser: v.trim() }); setMsg('Saved'); onSaved(p.userId, r.data.agentUser); } catch (e) { setMsg(errOf(e, 'Not saved.')); } finally { setBusy(false); }
  };
  return (
    <tr data-testid="vici-agent-row">
      <td>{p.name}<div className="small-muted" style={{ fontSize: 11 }}>{p.email}</div></td>
      <td>{p.role}{p.mayCall ? '' : <div className="small-muted" style={{ fontSize: 11 }}>may not call</div>}</td>
      <td>{p.agentUser ? <b>{p.agentUser}</b> : <span className="small-muted">not set</span>}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <input aria-label={`ViciDial agent ID of ${p.name}`} value={v} maxLength={40} onChange={(e) => setV(e.target.value)} placeholder="e.g. 1012" style={{ width: 110 }} />{' '}
        <button type="button" className="btn btn-sm" disabled={busy || v.trim() === (p.agentUser || '')} onClick={save}>{busy ? '…' : 'Save'}</button>
        {msg && <span className="small-muted" style={{ marginLeft: 6, fontSize: 11.5 }}>{msg}</span>}
      </td>
    </tr>
  );
}

export default function VicidialCard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [f, setF] = useState({ server: '', apiUser: '', apiPass: '', phoneCode: '91' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const take = (data) => { setD(data); setF({ server: data.settings.server || '', apiUser: data.settings.apiUser || '', apiPass: '', phoneCode: data.settings.phoneCode || '91' }); };
  useEffect(() => { api.get('/browser-calling/vicidial/admin').then((r) => take(r.data)).catch((e) => setErr(errOf(e, 'Could not load the ViciDial settings.'))); }, []);
  if (err) return null; // not an Admin: the card is not shown
  if (!d) return null;
  const s = d.settings;
  const put = async (body, okText) => {
    setBusy(true); setMsg(null);
    try { const r = await api.put('/browser-calling/vicidial/admin', body); take(r.data); setMsg({ ok: true, text: okText }); } catch (e) { setMsg({ ok: false, text: errOf(e, 'Not saved.') }); } finally { setBusy(false); }
  };
  const saveFields = () => put({ server: f.server.trim(), apiUser: f.apiUser.trim(), phoneCode: f.phoneCode.trim(), ...(f.apiPass ? { apiPass: f.apiPass } : {}) }, 'Saved.');
  const onSaved = (userId, agentUser) => setD((x) => ({ ...x, people: x.people.map((p) => (p.userId === userId ? { ...p, agentUser } : p)) }));
  const people = d.people.filter((p) => !q || `${p.name} ${p.email} ${p.agentUser || ''}`.toLowerCase().includes(q.toLowerCase()));
  const setCount = d.people.filter((p) => p.agentUser).length;
  return (
    <div className="panel panel-pad" style={{ marginBottom: 14 }} data-testid="vicidial-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 2 }}>☎ ViciDial (office dialer)</h3>
          <div className="cell-muted" style={{ fontSize: 12.5, maxWidth: 720 }}>
            Click to dial: a recruiter picks &quot;ViciDial&quot; in &quot;Call using&quot; and presses Call. Their browser, on the office network, asks the office ViciDial to dial the
            candidate on their own ViciDial agent screen (normal ViciDial carriers and recording). TeamLink&apos;s server never contacts ViciDial and nothing on ViciDial is changed.
          </div>
        </div>
        <div data-testid="vici-switch" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className={`status ${s.enabled ? 'active' : 'pending'}`}>{s.enabled ? 'On' : 'Off'}</span>
          <button type="button" className={`btn btn-sm${s.enabled ? ' btn-primary' : ''}`} disabled={busy || s.enabled} onClick={() => put({ enabled: true }, 'ViciDial is On: people with an agent ID can pick it in "Call using".')}>On</button>
          <button type="button" className={`btn btn-sm${!s.enabled ? ' btn-primary' : ''}`} disabled={busy || !s.enabled} onClick={() => put({ enabled: false }, 'ViciDial is Off.')}>Off</button>
        </div>
      </div>
      <div className="notice" style={{ margin: '10px 0', fontSize: 12.5 }}>{s.note}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <label className="field"><span>Server address</span><input aria-label="ViciDial server address" value={f.server} placeholder="http://192.168.0.200" onChange={(e) => setF({ ...f, server: e.target.value })} /></label>
        <label className="field"><span>API user</span><input aria-label="ViciDial API user" value={f.apiUser} autoComplete="off" onChange={(e) => setF({ ...f, apiUser: e.target.value })} /></label>
        <label className="field"><span>API password</span><input aria-label="ViciDial API password" type="password" autoComplete="new-password" value={f.apiPass} placeholder={s.hasPassword ? '•••••• stored (type to change)' : 'not set'} onChange={(e) => setF({ ...f, apiPass: e.target.value })} /></label>
        <label className="field"><span>Phone code</span><input aria-label="ViciDial phone code" value={f.phoneCode} maxLength={4} onChange={(e) => setF({ ...f, phoneCode: e.target.value })} /></label>
      </div>
      {!s.passwordReadable && <div className="notice red">The stored API password cannot be read on this server (the encryption key changed). Type it again.</div>}
      {!d.secretsReady && <div className="notice red">INTEGRATION_SECRET_KEY is not set on this server, so the API password cannot be stored.</div>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0 4px', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={saveFields}>{busy ? 'Saving…' : 'Save'}</button>
        {s.hasPassword && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => put({ clearPassword: true, enabled: false }, 'Password removed; ViciDial is Off.')}>Remove the password</button>}
        {d.missing.length > 0 && <span className="small-muted">To switch it on, fill in: {d.missing.join(', ')}.</span>}
        {d.browserCallingMode === 'Off' && <span className="small-muted">Browser calling is Off (Omni-Channel &gt; AI Voice &gt; Browser calling): ViciDial follows its switch, roles and Test numbers.</span>}
        {d.browserCallingMode === 'Test' && <span className="small-muted">Browser calling is in Test mode: only its Test numbers can be dialled.</span>}
      </div>
      {msg && <div className={`notice${msg.ok ? '' : ' red'}`} style={{ marginTop: 6 }}>{msg.text}</div>}
      <div className="section-label" style={{ margin: '14px 0 4px' }}>Each person&apos;s ViciDial agent ID ({setCount} of {d.people.length} set)</div>
      <div className="small-muted" style={{ fontSize: 12, marginBottom: 6 }}>The ViciDial user each person logs in to the agent screen with. People without one see ViciDial as &quot;not connected yet&quot;.</div>
      <input aria-label="Search people" placeholder="Search a name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260, marginBottom: 6 }} />
      <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th>ViciDial agent ID</th><th>Change</th></tr></thead>
          <tbody>{people.map((p) => <AgentRow key={p.userId} p={p} onSaved={onSaved} />)}</tbody>
        </table>
      </div>
    </div>
  );
}
