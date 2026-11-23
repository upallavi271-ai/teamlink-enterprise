import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useBrowserCall } from './CallProvider.jsx';

// Browser calling > PHONE LINES (Admin, 2026-11-23): where a manual call leaves our phone system - the built-in office Synway, plus any
// Synway / Dinstar SIM gateway, ViciDial server or other SIP line by IP address. The server writes the Asterisk config; passwords are
// shown once and never again.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const KIND_WORD = { admin: 'Admin', tl: 'Team Lead', recruiter: 'Recruiter', hr: 'HR', bdetl: 'BDE TL', bde: 'BDE' };
const BLANK = { type: 'dinstar', name: '', connect: 'register', host: '', port: 5060, transport: 'udp', username: '', password: '', acceptFromIpOnly: false, dialFormat: '10', prefix: '', callerId: '', maxCalls: 4, kinds: [], same: true };
const STATE_COLOR = { Registered: '#067647', Reachable: '#067647', Unreachable: '#b42318', 'Not registered': '#b54708', 'Not loaded': '#b54708' };

function SetupBox({ setup, onClose }) {
  if (!setup) return null;
  return (
    <div className="notice green" role="alert" style={{ display: 'block' }} data-testid="line-setup">
      <b>Type these into the device now. The password is shown only this once.</b>
      <table className="table" style={{ marginTop: 6, maxWidth: 520 }}>
        <tbody>
          <tr><td>Server (registrar / proxy)</td><td><code>{setup.server}</code></td></tr>
          <tr><td>Port</td><td><code>{setup.port}</code> ({setup.transport})</td></tr>
          <tr><td>Username (account, auth ID)</td><td><code>{setup.username}</code></td></tr>
          <tr><td>Password</td><td><code>{setup.password}</code></td></tr>
        </tbody>
      </table>
      <button type="button" className="btn btn-sm" onClick={onClose}>I have typed it in</button>
    </div>
  );
}

export default function PhoneLinesSection({ testNumbers = [] }) {
  const bc = useBrowserCall();
  const [data, setData] = useState(null);
  const [live, setLive] = useState(null);
  const [form, setForm] = useState(null); // null | { ...BLANK, id? }
  const [setup, setSetup] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [testNo, setTestNo] = useState('');
  const load = useCallback(() => api.get('/browser-calling/admin/lines').then((r) => setData(r.data)).catch((e) => setMsg(errOf(e, 'Could not load the phone lines.'))), []);
  const loadLive = useCallback(() => api.get('/browser-calling/admin/lines/status').then((r) => setLive(r.data)).catch(() => setLive({ reachable: false, reason: 'Could not read the line states.', lines: {} })), []);
  useEffect(() => { load(); loadLive(); }, [load, loadLive]);
  useEffect(() => { if (!testNo && testNumbers.length) setTestNo(testNumbers[0]); }, [testNumbers, testNo]);
  if (!data) return msg ? <div className="notice red">{msg}</div> : null;

  const type = form && data.types.find((t) => t.id === form.type);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const edit = (l) => setForm({ ...BLANK, ...l, id: l.id, host: l.host || '', port: l.port || 5060, username: l.connect === 'ip' ? (l.username || '') : '', password: '', prefix: l.prefix || '', callerId: l.callerId || '', kinds: l.kinds || [], same: !!l.sameAsBrowserCalling });
  const save = async () => {
    setBusy(true); setMsg('');
    const body = { name: form.name, type: form.type, connect: form.connect, host: form.host, acceptFromIpOnly: form.acceptFromIpOnly, dialFormat: form.dialFormat, prefix: form.prefix, callerId: form.callerId, maxCalls: Number(form.maxCalls), kinds: form.same ? [] : form.kinds };
    if (form.connect === 'ip') Object.assign(body, { port: Number(form.port) || 5060, transport: form.transport, username: form.username, ...(form.password ? { password: form.password } : {}) });
    try {
      const r = form.id ? await api.put(`/browser-calling/admin/lines/${form.id}`, body) : await api.post('/browser-calling/admin/lines', body);
      setMsg(r.data.message || 'Saved.'); if (r.data.setup) setSetup(r.data.setup);
      setForm(null); load(); loadLive(); if (bc.refresh) bc.refresh();
    } catch (e) { setMsg(errOf(e, 'Could not save the line.')); } finally { setBusy(false); }
  };
  const toggle = async (l) => {
    try { const r = await api.put(`/browser-calling/admin/lines/${l.id}`, { active: !l.active }); setMsg(r.data.message); load(); loadLive(); if (bc.refresh) bc.refresh(); } catch (e) { setMsg(errOf(e, 'Could not change the line.')); }
  };
  const newPass = async (l) => {
    if (!window.confirm(`Make a new password for "${l.name}"? The device stops working until you type the new one into it.`)) return; // eslint-disable-line no-alert
    try { const r = await api.post(`/browser-calling/admin/lines/${l.id}/new-password`); setSetup(r.data.setup); setMsg(r.data.message); } catch (e) { setMsg(errOf(e, 'Could not make a new password.')); }
  };
  const test = (l) => {
    if (!testNo) { setMsg('Add your own phone number to "Test numbers" above first.'); return; }
    bc.testCall({ lineId: l.id, number: testNo, lineName: l.name });
  };

  return (
    <div className="card section" style={{ marginBottom: 12 }} data-testid="phone-lines">
      <div className="section-label">Phone lines</div>
      <div className="small-muted" style={{ marginBottom: 8 }}>Where a call leaves our phone system. The office Synway SIM line is built in. Add a Dinstar or Synway SIM gateway, a ViciDial server or any SIP line by its IP address; people then pick it in &quot;Call using&quot;.</div>
      {!data.pbx && <div className="notice amber">This server is not the phone system (no /etc/asterisk here): lines are saved in TeamLink, but Asterisk is not changed from this server.</div>}
      {data.lastWrite && data.lastWrite.error && <div className="notice red">{data.lastWrite.error}</div>}
      {live && !live.reachable && <div className="small-muted" style={{ marginBottom: 6 }}>Live state: {live.reason}</div>}
      <SetupBox setup={setup} onClose={() => setSetup(null)} />
      <table className="table">
        <thead><tr><th>Line</th><th>Kind</th><th>How it connects</th><th>Status</th><th>At once</th><th>Who</th><th /></tr></thead>
        <tbody>
          {data.lines.map((l) => {
            const st = live && live.lines && live.lines[l.id];
            return (
              <tr key={l.id} style={l.active ? undefined : { opacity: 0.55 }}>
                <td><b>{l.name}</b>{l.builtIn && <div className="small-muted">Built in, own config</div>}{!l.active && <div className="small-muted">Switched off</div>}</td>
                <td>{l.typeLabel}</td>
                <td>{l.connect === 'ip' ? `${l.host}:${l.port} ${String(l.transport).toUpperCase()}` : `Registers to us as ${l.username}`}{l.prefix ? <div className="small-muted">Prefix {l.prefix}</div> : null}</td>
                <td title={st ? st.detail || '' : ''}>{st ? <span style={{ color: STATE_COLOR[st.state] }}>{st.state}{st.rttMs != null ? ` · ${st.rttMs} ms` : ''}</span> : <span className="small-muted">—</span>}</td>
                <td>{l.maxCalls || '—'}</td>
                <td className="small-muted">{l.sameAsBrowserCalling ? 'Same as browser calling' : l.kinds.map((k) => KIND_WORD[k] || k).join(', ')}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {l.active && <button type="button" className="btn btn-sm" onClick={() => test(l)} disabled={!bc.available} title={bc.available ? `Calls ${testNo || 'your test number'} on this line` : 'Switch browser calling to Test or Live first'}>Test call</button>}
                  {!l.builtIn && <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => edit(l)}>Edit</button>}
                  {!l.builtIn && <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => toggle(l)}>{l.active ? 'Switch off' : 'Switch on'}</button>}
                  {!l.builtIn && l.connect === 'register' && <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => newPass(l)}>New password</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {!form && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setForm({ ...BLANK }); setMsg(''); }}>+ Add a line</button>}
        <button type="button" className="btn btn-sm" onClick={loadLive}>Refresh status</button>
        {testNumbers.length > 0 && (
          <label className="small-muted">Test calls go to{' '}
            <select value={testNo} onChange={(e) => setTestNo(e.target.value)} aria-label="Test number">{testNumbers.map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>
        )}
      </div>
      {msg && <div className="small-muted" style={{ marginTop: 6 }} role="status">{msg}</div>}

      {form && (
        <div className="card" style={{ marginTop: 10, padding: 12 }} data-testid="line-form">
          <div className="section-label" style={{ marginTop: 0 }}>{form.id ? `Edit "${form.name}"` : 'Add a line'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <label className="field"><span>Kind of line</span>
              <select value={form.type} onChange={(e) => set({ type: e.target.value })} aria-label="Kind of line">{data.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
            </label>
            <label className="field"><span>Name</span><input value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Dinstar office 2" aria-label="Line name" /></label>
          </div>
          {type && <div className="small-muted" style={{ margin: '0 0 10px' }}>{type.help}</div>}
          <div className="field"><span>How it connects</span>
            {data.connects.map((c) => (
              <label key={c.id} style={{ display: 'block', fontSize: 13 }}>
                <input type="radio" name="line-connect" checked={form.connect === c.id} disabled={!!form.id} onChange={() => set({ connect: c.id })} /> {c.label}
              </label>
            ))}
            {form.id && <div className="small-muted">The way it connects cannot be changed (the device was set up for it). Add a new line instead.</div>}
          </div>
          {form.connect === 'register' ? (
            <div className="small-muted" style={{ marginBottom: 8 }}>
              After you save, TeamLink shows the values to type into the device: server <b>{data.register.server}</b>, port <b>{data.register.port}</b> ({data.register.transport}), a username and a new password.
            </div>
          ) : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <label className="field"><span>{form.connect === 'ip' ? 'IP address or host' : "Device's public IP (optional)"}</span><input value={form.host} onChange={(e) => set({ host: e.target.value.trim() })} placeholder={form.connect === 'ip' ? '203.0.113.10' : '183.82.4.247'} aria-label="IP address" /></label>
            {form.connect === 'ip' && <label className="field"><span>Port</span><input type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: e.target.value })} aria-label="Port" /></label>}
            {form.connect === 'ip' && (
              <label className="field"><span>Transport</span>
                <select value={form.transport} onChange={(e) => set({ transport: e.target.value })} aria-label="Transport"><option value="udp">UDP</option><option value="tcp">TCP</option></select>
              </label>
            )}
            {form.connect === 'ip' && <label className="field"><span>Username (only if it asks)</span><input value={form.username} autoComplete="off" onChange={(e) => set({ username: e.target.value.trim() })} aria-label="Username" /></label>}
            {form.connect === 'ip' && <label className="field"><span>Password (only if it asks)</span><input type="password" autoComplete="new-password" value={form.password} placeholder={form.id && form.hasPassword ? 'saved - type to change' : ''} onChange={(e) => set({ password: e.target.value })} aria-label="Password" /></label>}
          </div>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 10 }}>
            <input type="checkbox" checked={!!form.acceptFromIpOnly} onChange={(e) => set({ acceptFromIpOnly: e.target.checked })} /> Accept calls from this IP only
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <label className="field"><span>Dial the number as</span>
              <select value={form.dialFormat} onChange={(e) => set({ dialFormat: e.target.value })} aria-label="Dial format">{data.formats.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
            </label>
            <label className="field"><span>Prefix (optional)</span><input value={form.prefix} maxLength={8} onChange={(e) => set({ prefix: e.target.value.trim() })} placeholder="e.g. 9 or a port-group prefix" aria-label="Prefix" /></label>
            <label className="field"><span>Caller ID (optional)</span><input value={form.callerId} onChange={(e) => set({ callerId: e.target.value.trim() })} placeholder="the number people see" aria-label="Caller ID" /></label>
            <label className="field"><span>Max calls at once</span><input type="number" min={1} max={64} value={form.maxCalls} onChange={(e) => set({ maxCalls: e.target.value })} aria-label="Max calls at once" /></label>
          </div>
          <div className="field"><span>Who may use it</span>
            <label style={{ display: 'block', fontSize: 13 }}><input type="checkbox" checked={form.same} onChange={(e) => set({ same: e.target.checked })} /> Same as browser calling ({(data.browserKinds || []).map((k) => KIND_WORD[k] || k).join(', ')})</label>
            {!form.same && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
                {data.allKinds.map((k) => (
                  <label key={k} style={{ fontSize: 13 }}>
                    <input type="checkbox" checked={form.kinds.includes(k)} onChange={(e) => set({ kinds: e.target.checked ? [...form.kinds, k] : form.kinds.filter((x) => x !== k) })} /> {KIND_WORD[k] || k}
                  </label>
                ))}
              </div>
            )}
            <div className="small-muted">An Admin can always use every line.</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save line'}</button>
            <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
