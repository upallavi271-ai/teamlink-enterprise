import { useEffect, useState } from 'react';
import api from '../../api';
import OmniWhatsappMap from './OmniWhatsappMap.jsx';
import OmniGsAccess from './OmniGsAccess.jsx';

// Administration > Integrations > Omni-Channel (founder 2026-10-30: "both application is same").
// TeamLink and Omni-Channel use ONE set of connections: Email, SMS, WhatsApp and the Facebook Page (Social Media card) are typed here in TeamLink and Omni-Channel gets the
// same ones by itself (backend utils/greenStartIntegrations.js). What Omni-Channel connected itself (Facebook, Instagram, Shopify ...)
// is listed below. Status only: no password, key or token ever comes to this screen.
const NAME = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', facebook: 'Facebook Page', rcs: 'RCS (rcssms.in)', x: 'X (Twitter)', linkedin: 'LinkedIn', youtube: 'YouTube' };
const STATE = {
  sent: ['Same as TeamLink', 'live'], same: ['Same as TeamLink', 'live'], removed: ['Disconnected (TeamLink has none)', 'draft'],
  skipped: ['Not given', 'draft'], failed: ['Did not work', 'red'],
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// Omni-Channel BY DEPARTMENT (founder 2026-11-02, backend utils/omniDeptLogins.js): a WhatsApp number's department decides its workspace
// ("Teamlink <Department>"); each department has its own Omni-Channel login, a member of only that workspace. Super Admin and Admin
// open the company account (every department); everybody else opens their department's login (their number, its replies, campaigns).
function DepartmentLogins({ canConfigure }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api.get('/omni-gs/departments').then((r) => setD(r.data)).catch(() => setD({ departments: [], last: null }));
  useEffect(() => { load(); }, []);
  async function run() {
    setBusy(true); setMsg('');
    try { const r = await api.post('/omni-gs/departments/run'); setMsg(r.data.words); await load(); } catch (e) { setMsg(e.response?.data?.error || 'It could not be set up.'); } finally { setBusy(false); }
  }
  const rows = (d && d.departments) || [];
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <b>Departments in Omni-Channel</b>
          <div className="small-muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
            Give each WhatsApp number one department (Connections &gt; WhatsApp &gt; the number&apos;s access). That department gets its own Omni-Channel workspace
            with that number, and its own login: its people see only their number, its replies and their campaigns. Super Admin and Admin see every department.
          </div>
        </div>
        {canConfigure && <button className="btn" onClick={run} disabled={busy}>{busy ? 'Setting up…' : 'Set up department logins now'}</button>}
      </div>
      {msg && <div className="small-muted" role="status" style={{ marginTop: 10 }}>{msg}</div>}
      {d && d.last && <div className="small-muted" style={{ marginTop: 8 }}>Last checked {when(d.last.at)}: {d.last.words}</div>}
      {rows.length > 0 && (
        <table className="table" style={{ marginTop: 10 }}>
          <thead><tr><th>Department</th><th>Workspace</th><th>WhatsApp number</th><th>Its Omni-Channel login</th><th>State</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={`${r.dept}-${r.number}`}>
              <td><b>{r.dept}</b></td><td>{r.workspace || '—'}</td><td>{r.number || <span className="small-muted">none now</span>}</td>
              <td style={{ fontSize: 12 }}>{r.email || '—'}</td>
              <td><Chip tone={r.state === 'ready' ? 'live' : 'red'}>{r.state === 'ready' ? 'Ready' : 'Did not work'}</Chip>{r.words && <div className="small-muted" style={{ fontSize: 12, marginTop: 2 }}>{r.words}</div>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function Chip({ tone, children }) {
  const bg = tone === 'live' ? '#e8f7ef' : tone === 'red' ? '#fdecec' : '#f1f3f6';
  const fg = tone === 'live' ? '#1c7c4a' : tone === 'red' ? '#b42318' : '#555';
  return <span style={{ background: bg, color: fg, borderRadius: 10, padding: '2px 8px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}

export default function OmniChannelIntegrations({ canConfigure }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => api.get('/admin/integrations-omni-channel').then((r) => { setData(r.data); setErr(''); }).catch((e) => setErr(e.response?.data?.error || 'Could not load.'));
  useEffect(() => { load(); }, []);

  async function sendNow() {
    setBusy(true); setMsg('');
    try { const r = await api.post('/admin/integrations-omni-channel/sync'); setMsg(r.data.words); await load(); } catch (e) { setMsg(e.response?.data?.error || 'It could not be sent.'); } finally { setBusy(false); }
  }

  if (err) return <div className="error-text">{err}</div>;
  if (!data) return <div className="small-muted">Loading…</div>;
  const last = data.last;
  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <b>TeamLink and Omni-Channel use the same connections</b>
            <div className="small-muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
              Type Email, SMS and WhatsApp once, on the <b>Connections</b> tab here. Omni-Channel gets the same ones by itself a few seconds after you save, and again every hour.
              You never connect them again inside Omni-Channel.
            </div>
          </div>
          {canConfigure && <button className="btn btn-primary" onClick={sendNow} disabled={busy}>{busy ? 'Sending…' : 'Send to Omni-Channel now'}</button>}
        </div>
        {msg && <div className="small-muted" role="status" style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      <DepartmentLogins canConfigure={canConfigure} />
      <OmniGsAccess canConfigure={canConfigure} />

      <OmniWhatsappMap onSaved={load} />

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <b>From TeamLink to Omni-Channel</b>
        <div className="small-muted" style={{ margin: '4px 0 10px' }}>
          {last ? `Last sent ${when(last.at)}${last.account ? ` to the account ${last.account}` : ''}. ${last.words}` : 'Not sent yet.'}
        </div>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Connection</th><th>In TeamLink</th>{(last?.workspaces || []).map((w) => <th key={w.id}>Omni-Channel: {w.name}</th>)}</tr></thead>
          <tbody>{['email', 'sms', 'whatsapp', 'facebook', 'rcs', 'x', 'linkedin', 'youtube'].map((ch) => (
            <tr key={ch}>
              <td><b>{NAME[ch]}</b></td>
              <td>{data.teamlink[ch]?.ready ? <Chip tone="live">Set up</Chip> : <span className="small-muted">{data.teamlink[ch]?.words || 'Not set up'}</span>}</td>
              {(last?.workspaces || []).map((w) => {
                const c = w.channels[ch] || {};
                const [word, tone] = STATE[c.state] || ['-', 'draft'];
                return <td key={w.id}><Chip tone={tone}>{word}</Chip>{c.state !== 'same' && c.state !== 'sent' && c.words ? <div className="small-muted" style={{ fontSize: 11.5, marginTop: 3, maxWidth: 280 }}>{c.words}</div> : null}</td>;
              })}
            </tr>
          ))}</tbody>
        </table></div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <b>Connected inside Omni-Channel</b>
        <div className="small-muted" style={{ margin: '4px 0 10px' }}>Social media, Shopify, ads and the rest that Omni-Channel connected itself. They work for both: Omni-Channel is part of TeamLink.</div>
        {data.connectionsError ? <div className="small-muted">{data.connectionsError}</div> : (data.connections?.workspaces || []).map((w) => (
          <div key={w.id} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{w.name}</div>
            {w.items.length === 0 ? <div className="small-muted">Nothing connected yet.</div> : (
              <div className="tbl-wrap"><table>
                <thead><tr><th>Connection</th><th>Kind</th><th>Account</th><th>Status</th></tr></thead>
                <tbody>{w.items.map((x) => (
                  <tr key={x.provider}>
                    <td><b>{x.label || x.provider}</b></td>
                    <td>{x.category || ''}</td>
                    <td>{x.account}</td>
                    <td><Chip tone={x.status === 'CONNECTED' ? 'live' : x.status === 'ERROR' ? 'red' : 'draft'}>{x.status === 'CONNECTED' ? 'Connected' : x.status === 'ERROR' ? 'Problem' : x.status.charAt(0) + x.status.slice(1).toLowerCase()}</Chip>{x.lastError ? <div className="small-muted" style={{ fontSize: 11.5 }}>{x.lastError}</div> : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
