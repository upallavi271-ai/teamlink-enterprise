import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useBrowserCall } from './CallProvider.jsx';

// Browser calling > SIM NUMBERS (Admin, 2026-11-25: "assign one number to a particular recruiter, so their calls go out from that number and
// when the candidate calls back, the call comes to that recruiter"). The office Synway's GSM ports in use, each given to at most one person.
// The server writes the phone-system text (extensions_tl_sims.conf and the p<NN> part of extensions_tl_lines.conf); nothing here talks to the gateway.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const BLANK = { port: '', simNumber: '', operator: 'Jio', active: true, userId: '', dialPrefix: '', matchBy: 'number', tag: '', note: '' };
const pad2 = (n) => String(n || '').padStart(2, '0');

export default function SimNumbersSection() {
  const bc = useBrowserCall();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState('');
  const [checked, setChecked] = useState(null);
  const [preview, setPreview] = useState(null);
  const load = useCallback(() => api.get('/browser-calling/admin/sims').then((r) => setData(r.data)).catch((e) => setMsg(errOf(e, 'Could not load the SIM numbers.'))), []);
  useEffect(() => { load(); }, [load]);
  if (!data) return msg ? <div className="notice red">{msg}</div> : null;

  const done = (r) => { setData(r.data); setMsg(r.data.message || 'Saved.'); if (bc.refresh) bc.refresh(); if (preview) api.get('/browser-calling/admin/sims/preview').then((p) => setPreview(p.data)).catch(() => {}); };
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const save = async () => {
    setBusy(true); setMsg('');
    const body = { port: Number(form.port), simNumber: form.simNumber, operator: form.operator, active: form.active, userId: form.userId || '', dialPrefix: form.dialPrefix, matchBy: form.matchBy, tag: form.tag, note: form.note };
    try { const r = form.id ? await api.put(`/browser-calling/admin/sims/${form.id}`, body) : await api.post('/browser-calling/admin/sims', body); done(r); setForm(null); } catch (e) { setMsg(errOf(e, 'Could not save the SIM port.')); load(); } finally { setBusy(false); }
  };
  const put = async (s, patch) => { try { done(await api.put(`/browser-calling/admin/sims/${s.id}`, patch)); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const remove = async (s) => {
    if (!window.confirm(`Remove port ${s.portLabel}${s.simNumber ? ` (${s.simNumber})` : ''} from the list? Calls to it then hang up, and ${s.userName || 'nobody'} goes back to the normal office line.`)) return; // eslint-disable-line no-alert
    try { done(await api.delete(`/browser-calling/admin/sims/${s.id}`)); } catch (e) { setMsg(errOf(e, 'Could not remove it.')); }
  };
  const setting = async (patch) => { try { done(await api.put('/browser-calling/admin/sims-settings', patch)); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const runCheck = async () => { try { const r = await api.get('/browser-calling/admin/sims/route', { params: { called: check } }); setChecked(r.data); } catch (e) { setChecked({ error: errOf(e, 'Could not check it.') }); } };
  const togglePreview = async () => { if (preview) { setPreview(null); return; } try { setPreview((await api.get('/browser-calling/admin/sims/preview')).data); } catch (e) { setMsg(errOf(e, 'Could not show it.')); } };
  const st = data.settings;
  const taken = new Set(data.sims.map((s) => s.userId).filter(Boolean));
  const usedPorts = new Set(data.sims.map((s) => s.port));
  const free = Array.from({ length: data.portMax }, (_, i) => i + 1).filter((n) => !usedPorts.has(n));

  return (
    <div className="card section" style={{ marginBottom: 12 }} data-testid="sim-numbers">
      <div className="section-label">SIM numbers</div>
      <div className="small-muted" style={{ marginBottom: 8 }}>Give each recruiter one SIM of the office Synway. Their calls go out from that SIM, and when a candidate calls that number back it rings the recruiter&apos;s TeamLink. A person has one SIM; BDEs and Managers never get one.</div>
      {!data.pbx && <div className="notice amber">This server is not the phone system: SIM numbers are saved in TeamLink, but Asterisk is not changed from this server.</div>}
      {data.lastWrite && data.lastWrite.error && <div className="notice red">{data.lastWrite.error}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }} data-testid="sim-routing">
        <b style={{ fontSize: 13 }}>Port prefix routing</b>
        {[true, false].map((on) => <button key={String(on)} type="button" className={`btn btn-sm${st.prefixRouting === on ? ' btn-primary' : ''}`} onClick={() => setting({ prefixRouting: on })}>{on ? 'On' : 'Off'}</button>)}
        <span className="small-muted">{st.prefixRouting ? 'On: a recruiter with a SIM dials "<prefix><number>", and the gateway picks their port by that prefix.' : 'Off: calls go out as today (the gateway picks any free SIM). Switch on only after the prefix rules are set on the gateway.'}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>&quot;Call back&quot; task for a missed call</b>
        {[true, false].map((on) => <button key={String(on)} type="button" className={`btn btn-sm${st.missedTask === on ? ' btn-primary' : ''}`} onClick={() => setting({ missedTask: on })}>{on ? 'On' : 'Off'}</button>)}
        <span className="small-muted">A missed call always shows in the bell and the candidate&apos;s call history; this also adds a follow-up due now.</span>
      </div>
      <label className="small-muted" style={{ display: 'block', marginBottom: 8 }}>Calls to an unknown number or a SIM with nobody on it ring{' '}
        <select aria-label="Fallback person" value={st.fallbackUserId || ''} onChange={(e) => setting({ fallbackUserId: e.target.value })}>
          <option value="">nobody (hang up, as today)</option>
          {data.people.map((p) => <option key={p.userId} value={p.userId}>{p.name} · {p.role}</option>)}
        </select>
      </label>

      <table className="table">
        <thead><tr><th>Port</th><th>SIM number</th><th>Operator</th><th>Given to</th><th>Dial prefix</th><th>Incoming matched by</th><th /></tr></thead>
        <tbody>
          {data.sims.length === 0 && <tr><td colSpan={7} className="small-muted">No SIM ports yet. Add the ports that have a SIM in them.</td></tr>}
          {data.sims.map((s) => (
            <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }} data-testid={`sim-row-${s.portLabel}`}>
              <td><b>{s.portLabel}</b>{!s.active && <div className="small-muted">Switched off</div>}</td>
              <td>{s.simNumber || <span className="small-muted">not known yet</span>}</td>
              <td>{s.operator || '—'}</td>
              <td>
                <select aria-label={`Port ${s.portLabel} given to`} value={s.userId || ''} onChange={(e) => put(s, { userId: e.target.value })}>
                  <option value="">Nobody</option>
                  {data.people.filter((p) => p.userId === s.userId || !taken.has(p.userId)).map((p) => <option key={p.userId} value={p.userId}>{p.name} · {p.role}</option>)}
                </select>
                {s.userId && <div className="small-muted">Browser extension {s.extension || '—'}</div>}
              </td>
              <td><code>{s.dialPrefix}</code></td>
              <td>{s.matchLabel}{s.matchBy === 'tag' ? <> <code>{s.tag}</code></> : null}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="btn btn-sm" onClick={() => { setForm({ ...BLANK, ...s, userId: s.userId || '', id: s.id }); setMsg(''); }}>Edit</button>
                <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => put(s, { active: !s.active })}>{s.active ? 'Switch off' : 'Switch on'}</button>
                <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => remove(s)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {!form && free.length > 0 && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setForm({ ...BLANK, port: free[0] }); setMsg(''); }}>+ Add a SIM port</button>}
        <button type="button" className="btn btn-sm" onClick={togglePreview}>{preview ? 'Hide the phone system text' : 'Show the phone system text'}</button>
        <label className="small-muted">Check a called number{' '}
          <input value={check} onChange={(e) => setCheck(e.target.value.trim())} placeholder="9876543210 or port01" aria-label="Called number to check" style={{ width: 150 }} />
        </label>
        <button type="button" className="btn btn-sm" disabled={!check} onClick={runCheck}>Check</button>
        {checked && <span className="small-muted" data-testid="sim-check">{checked.error || (checked.nobody ? 'Nobody: the call hangs up.' : `Rings ${checked.userName || 'someone'} (extension ${checked.extension})${checked.fallback ? ' as the fallback' : ` on port ${pad2(checked.port)}`}.`)}</span>}
      </div>
      {msg && <div className="small-muted" style={{ marginTop: 6 }} role="status">{msg}</div>}

      {form && (
        <div className="card" style={{ marginTop: 10, padding: 12 }} data-testid="sim-form">
          <div className="section-label" style={{ marginTop: 0 }}>{form.id ? `Edit port ${pad2(form.port)}` : 'Add a SIM port'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <label className="field"><span>Port (1-{data.portMax})</span><input type="number" min={1} max={data.portMax} value={form.port} onChange={(e) => set({ port: e.target.value })} aria-label="Port" /></label>
            <label className="field"><span>SIM number</span><input value={form.simNumber} onChange={(e) => set({ simNumber: e.target.value })} placeholder="9876543210 (empty if not known)" aria-label="SIM number" /></label>
            <label className="field"><span>Operator</span>
              <select value={form.operator || ''} onChange={(e) => set({ operator: e.target.value })} aria-label="Operator">{data.operators.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            </label>
            <label className="field"><span>Given to</span>
              <select value={form.userId || ''} onChange={(e) => set({ userId: e.target.value })} aria-label="Given to">
                <option value="">Nobody</option>
                {data.people.filter((p) => p.userId === form.userId || !taken.has(p.userId) || (form.id && data.sims.find((x) => x.id === form.id && x.userId === p.userId))).map((p) => <option key={p.userId} value={p.userId}>{p.name} · {p.role}</option>)}
              </select>
            </label>
            <label className="field"><span>Dial prefix</span><input value={form.dialPrefix} maxLength={8} onChange={(e) => set({ dialPrefix: e.target.value.trim() })} placeholder={`${pad2(form.port || 1)}#`} aria-label="Dial prefix" /></label>
            <label className="field"><span>Incoming matched by</span>
              <select value={form.simNumber ? form.matchBy : 'tag'} disabled={!form.simNumber} onChange={(e) => set({ matchBy: e.target.value })} aria-label="Incoming matched by">{data.matchKinds.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            </label>
            {(form.matchBy === 'tag' || !form.simNumber) && <label className="field"><span>Port tag</span><input value={form.tag} maxLength={20} onChange={(e) => set({ tag: e.target.value.trim().toLowerCase() })} placeholder={`port${pad2(form.port || 1)}`} aria-label="Port tag" /></label>}
          </div>
          <div className="small-muted" style={{ margin: '4px 0 8px' }}>Dial prefix: what the gateway&apos;s IP to GSM rule looks for to pick this port (empty = {pad2(form.port || 1)}#). Incoming: the gateway puts this port&apos;s SIM number (or the tag) in the called number of a call it sends to us.</div>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}><input type="checkbox" checked={!!form.active} onChange={(e) => set({ active: e.target.checked })} /> On</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save SIM port'}</button>
            <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {preview && (
        <div style={{ marginTop: 10 }} data-testid="sim-preview">
          <div className="small-muted">{preview.file}</div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 320, overflow: 'auto', padding: 8, border: '1px solid var(--line, #e4e7ec)', borderRadius: 6 }}>{preview.inbound}{preview.route ? `\n; in [tl-line-route] (extensions_tl_lines.conf), while port prefix routing is on:\n${preview.route}` : ''}</pre>
        </div>
      )}
    </div>
  );
}
