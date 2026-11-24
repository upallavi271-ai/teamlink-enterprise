import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { useBrowserCall } from './CallProvider.jsx';

// Browser calling > ANDROID PHONES (Admin, 2026-11-24): pair the office Android phone (SIM 9032321414) with the TeamLink Phone app, say who may
// call on it, see its live status, unpair it. The app is downloaded from this server (/downloads/teamlink-phone.apk) and installed by hand.
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const TONE = { connected: '#067647', reconnecting: '#b54708', disconnected: '#667085', unavailable: '#b42318' };
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

function PeoplePick({ people, value, onChange }) {
  return (
    <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--border, #e4e7ec)', borderRadius: 6, padding: 6 }}>
      {people.map((p) => (
        <label key={p.userId} style={{ display: 'block', fontSize: 13 }}>
          <input type="checkbox" checked={value.includes(p.userId)} onChange={(e) => onChange(e.target.checked ? [...value, p.userId] : value.filter((x) => x !== p.userId))} /> {p.name} <span className="small-muted">· {p.role}</span>
        </label>
      ))}
      {people.length === 0 && <span className="small-muted">Nobody may call from the browser yet (Browser calling roles).</span>}
    </div>
  );
}

export default function AndroidPhonesSection() {
  const bc = useBrowserCall();
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(null);
  const [code, setCode] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => api.get('/browser-calling/phone/admin').then((r) => setData(r.data)).catch((e) => setMsg(errOf(e, 'Could not load the phones.'))), []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);
  if (!data) return msg ? <div className="notice red">{msg}</div> : null;
  const makeCode = async () => {
    setMsg('');
    try { const r = await api.post('/browser-calling/phone/admin/pair-code', form); setCode(r.data); setForm(null); } catch (e) { setMsg(errOf(e, 'Could not make the code.')); }
  };
  const setBridge = async (d, on) => { try { const r = await api.put(`/browser-calling/phone/admin/devices/${d.id}`, { bridge: on }); setData(r.data); setMsg(on ? 'Talk in TeamLink is on for this phone.' : 'Talk in TeamLink is off: recruiters talk on the phone itself.'); if (bc.refresh) bc.refresh(); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const saveUsers = async () => { try { const r = await api.put(`/browser-calling/phone/admin/devices/${edit.id}`, { userIds: edit.userIds, name: edit.name }); setData(r.data); setEdit(null); setMsg('Saved.'); if (bc.refresh) bc.refresh(); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const unpair = async (d) => {
    if (!window.confirm(`Unpair ${d.name} (${d.number})? The phone app stops taking calls at once; pairing again needs a new code.`)) return; // eslint-disable-line no-alert
    try { const r = await api.delete(`/browser-calling/phone/admin/devices/${d.id}`); setData(r.data); setMsg('Unpaired.'); if (bc.refresh) bc.refresh(); } catch (e) { setMsg(errOf(e, 'Could not unpair.')); }
  };
  return (
    <div className="card section" style={{ marginBottom: 12 }} data-testid="android-phones">
      <div className="section-label">Android phones</div>
      <div className="small-muted" style={{ marginBottom: 8 }}>
        A recruiter presses Call in TeamLink and the paired Android phone dials the candidate from its own SIM; they talk on that phone (or its Bluetooth headset).
        Install the <a href="/downloads/teamlink-phone.apk" download>TeamLink Phone app</a> on the phone (allow &quot;Install unknown apps&quot; once), then pair it with a code from here. Calls on the phone are not recorded.
      </div>
      <table className="table">
        <thead><tr><th>Phone</th><th>Status</th><th>Talk in TeamLink</th><th>Given to</th><th>Last in touch</th><th /></tr></thead>
        <tbody>
          {data.devices.length === 0 && <tr><td colSpan={6} className="small-muted">No phone paired yet.</td></tr>}
          {data.devices.map((d) => (
            <tr key={d.id} data-testid={`phone-row-${d.number}`}>
              <td><b>{d.name}</b><div className="small-muted">{d.number}{d.model ? ` · ${d.model}` : ''}{d.appVersion ? ` · app ${d.appVersion}` : ''}</div></td>
              <td><b style={{ color: TONE[d.status] }} data-testid="phone-admin-status">{d.statusWord}</b>{d.statusWhy && <div className="small-muted">{d.statusWhy}</div>}{d.battery != null && <div className="small-muted">Battery {d.battery}%</div>}</td>
              <td data-testid="phone-bridge">
                <div style={{ display: 'flex', gap: 4 }}>{[true, false].map((on) => <button key={String(on)} type="button" className={`btn btn-sm${d.bridge === on ? ' btn-primary' : ''}`} onClick={() => setBridge(d, on)}>{on ? 'On' : 'Off'}</button>)}</div>
                <div className="small-muted" style={{ fontSize: 11.5 }}>{d.bridge ? 'The office line calls the phone, the phone answers by itself, dials the candidate and joins the calls: talk in TeamLink. Set TeamLink Phone as the phone\'s Phone app. Two calls are billed.' : 'Recruiters talk on the phone itself.'}</div>
              </td>
              <td>{d.userNames.length ? d.userNames.join(', ') : <span className="small-muted">Nobody (Admins only)</span>}</td>
              <td className="small-muted">{when(d.lastSeenAt)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="btn btn-sm" onClick={() => setEdit({ id: d.id, name: d.name, userIds: d.userIds })}>Who may call</button>
                <button type="button" className="btn btn-sm" style={{ marginLeft: 4 }} onClick={() => unpair(d)}>Unpair</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!form && !code && <button type="button" className="btn btn-sm btn-primary" style={{ marginTop: 8 }} onClick={() => { setForm({ name: 'Office Android phone', number: '9032321414', userIds: [] }); setMsg(''); }}>+ Pair a phone</button>}
      {form && (
        <div className="card" style={{ marginTop: 10, padding: 12 }} data-testid="phone-pair-form">
          <div className="section-label" style={{ marginTop: 0 }}>Pair a phone</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label className="field"><span>Name</span><input value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Phone name" /></label>
            <label className="field"><span>The phone&apos;s SIM number</span><input value={form.number} maxLength={14} onChange={(e) => setForm({ ...form, number: e.target.value })} aria-label="Phone SIM number" /></label>
          </div>
          <div className="small-muted" style={{ margin: '8px 0 4px' }}>Who may call on this phone (one call at a time; the person talks on the phone itself):</div>
          <PeoplePick people={data.people} value={form.userIds} onChange={(v) => setForm({ ...form, userIds: v })} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={makeCode}>Make the pairing code</button>
            <button type="button" className="btn btn-sm" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {code && (
        <div className="notice" style={{ marginTop: 10 }} data-testid="phone-pair-code">
          In the TeamLink Phone app type the server <b>{window.location.origin}</b> and this code: <b style={{ fontSize: 22, letterSpacing: 4 }}>{code.code}</b>
          <div className="small-muted">For {code.name} ({code.number}). Works once, until {when(code.expiresAt)}. The phone appears above as soon as it pairs.</div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => { setCode(null); load(); }}>Done</button>
        </div>
      )}
      {edit && (
        <div className="card" style={{ marginTop: 10, padding: 12 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Who may call on {edit.name}</div>
          <PeoplePick people={data.people} value={edit.userIds} onChange={(v) => setEdit({ ...edit, userIds: v })} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={saveUsers}>Save</button>
            <button type="button" className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className="small-muted" style={{ marginTop: 6 }} role="status">{msg}</div>}
    </div>
  );
}
