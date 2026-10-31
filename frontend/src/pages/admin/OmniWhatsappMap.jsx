import { useEffect, useState } from 'react';
import api from '../../api';
import { useAuth } from '../../context/AuthContext';

// Integrations > Omni-Channel > WhatsApp numbers (founder 2026-10-31: "nenu integrate chesina whatsapp accounts omnichannel nuchi promotion
// chestey povali ... superadmin assign chesukuntaru enni numbers ina okka department ki assign cheyochu").
// Every WhatsApp number of TeamLink, and the Omni-Channel workspace it goes to. Omni-Channel keeps ONE WhatsApp number per workspace, so
// several numbers of one department each get their own workspace ("Medical - 1", "Medical - 2"). Only the Super Admin changes it.
// Server: GET / PUT /admin/integrations-omni-channel/whatsapp-map (utils/greenStartIntegrations.js). No token is shown.
const NEW = '__new__';

export default function OmniWhatsappMap({ onSaved }) {
  const { user } = useAuth();
  const isSA = user && user.role === 'SUPER_ADMIN';
  const [data, setData] = useState(null);
  const [pick, setPick] = useState({}); // numberId -> { choice: workspaceId | NEW | '', newName }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function fill(d) {
    setData(d);
    const p = {};
    d.numbers.forEach((n) => {
      const m = d.map[n.id];
      p[n.id] = m && m.workspaceId ? { choice: m.workspaceId, newName: '' } : m && m.newName ? { choice: NEW, newName: m.newName } : { choice: '', newName: '' };
    });
    setPick(p);
  }
  useEffect(() => { api.get('/admin/integrations-omni-channel/whatsapp-map').then((r) => fill(r.data)).catch((e) => setErr(e.response?.data?.error || 'Could not load the WhatsApp numbers.')); }, []);

  async function save() {
    setBusy(true); setErr(''); setMsg('');
    const map = {};
    Object.entries(pick).forEach(([id, v]) => {
      if (v.choice === NEW) map[id] = { newName: v.newName };
      else if (v.choice) map[id] = { workspaceId: v.choice };
    });
    try { const r = await api.put('/admin/integrations-omni-channel/whatsapp-map', { map }); fill(r.data); setMsg(r.data.message || 'Saved.'); if (onSaved) onSaved(); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } finally { setBusy(false); }
  }

  if (!data) return <div className="card" style={{ padding: 16, marginBottom: 16 }}>{err || 'Loading the WhatsApp numbers…'}</div>;
  const wsName = (id) => (data.workspaces.find((w) => w.id === id) || {}).name || 'a workspace that is gone';
  const used = Object.values(pick).filter((v) => v.choice && v.choice !== NEW).map((v) => v.choice);
  const twice = used.filter((id, i) => used.indexOf(id) !== i);

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <b>WhatsApp numbers in Omni-Channel</b>
      <div className="small-muted" style={{ margin: '4px 0 10px', lineHeight: 1.6 }}>
        Every WhatsApp number connected in TeamLink can send promotions from Omni-Channel. Omni-Channel keeps <b>one number per workspace</b>, so pick a
        workspace for each number, or <b>a new workspace</b> (for example &quot;Medical - 2&quot; when a department has several numbers). In Omni-Channel, open
        that workspace to send from that number. {isSA ? '' : 'Only the Super Admin can change this.'}
      </div>
      {data.workspacesError && <div className="small-muted" style={{ color: '#b42318', marginBottom: 8 }}>Omni-Channel: {data.workspacesError}</div>}
      <div className="tbl-wrap"><table>
        <thead><tr><th>WhatsApp number</th><th>Departments</th><th>Omni-Channel workspace</th></tr></thead>
        <tbody>{data.numbers.map((n) => {
          const v = pick[n.id] || { choice: '', newName: '' };
          return (
            <tr key={n.id}>
              <td><b>{n.label}</b>{n.isDefault ? <span className="small-muted"> · default</span> : null}<div className="small-muted" style={{ fontSize: 11.5 }}>{n.display || 'number not shown'}{n.ready ? '' : ` · not ready: ${n.problem || 'not set up'}`}</div></td>
              <td className="small-muted">{n.departments.length ? n.departments.join(', ') : 'none'}</td>
              <td>
                {isSA ? (
                  <>
                    <select value={v.choice} onChange={(e) => setPick({ ...pick, [n.id]: { choice: e.target.value, newName: v.newName || `${n.departments[0] || n.label}` } })} style={{ minWidth: 220 }}>
                      <option value="">Not in Omni-Channel</option>
                      {data.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      <option value={NEW}>＋ A new workspace…</option>
                    </select>
                    {v.choice === NEW && <input value={v.newName} maxLength={120} placeholder="New workspace name, e.g. Medical - 2" onChange={(e) => setPick({ ...pick, [n.id]: { ...v, newName: e.target.value } })} style={{ display: 'block', marginTop: 6, minWidth: 220 }} />}
                    {v.choice && v.choice !== NEW && twice.includes(v.choice) && <div style={{ color: '#b42318', fontSize: 12 }}>Another number is in this workspace too: one per workspace.</div>}
                  </>
                ) : (data.map[n.id] && data.map[n.id].workspaceId ? wsName(data.map[n.id].workspaceId) : <span className="small-muted">Not in Omni-Channel</span>)}
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>
      {isSA && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || twice.length > 0}>{busy ? 'Saving and sending…' : 'Save and send to Omni-Channel'}</button>
          <span className="small-muted" style={{ fontSize: 12 }}>A number taken out of a workspace is disconnected there (only what TeamLink put there).</span>
        </div>
      )}
      {msg && <div className="small-muted" role="status" style={{ marginTop: 8, color: '#1c7c4a' }}>{msg}</div>}
      {err && <div className="error-text" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
