import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import Channels from './Channels.jsx';
import Connections from './Connections.jsx';
import CreditsSettings from './CreditsSettings.jsx';
import { SenderDetails, SendingRules, ConsentLog, Roles } from './Settings.jsx';
import { SendingSettings } from './Campaigns.jsx';
import { Block } from './Dashboard.jsx';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CONFIGURATION (Admins only; the tab is not drawn for anyone else and the server refuses them).
//   Meta WhatsApp  ONE Meta account for the whole company, read from the WhatsApp card in Administration > Integrations (read only here),
//                  department mapping, how messages are routed, webhook, template approvals.
//   Channels       Email / WhatsApp / SMS / Call status and the links to HRMS, ATS, Accounts and the Job Portal.
//   Departments    the department list (from the Department master, Admin may add) with a head and a WhatsApp switch.
//   Permissions    who sees what (read only), the credit rules, and the Marketing capability.
//   Settings       Test mode and sending speed, sender identities, quiet hours and the same-job rule, the consent log.
// Servers: /api/outreach/config/*.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
const WA_WORD = { None: 'Not sent for approval', Pending: 'Waiting for WhatsApp', Approved: 'Approved', Rejected: 'Rejected' };

export function MetaWhatsapp() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [chk, setChk] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/outreach/config/meta').then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'The WhatsApp account could not be read.'))); }, []);
  const check = async () => { setBusy(true); setChk(null); try { setChk((await api.post('/outreach/config/meta/check')).data); } catch (e) { setChk({ ok: false, words: errOf(e, 'The check could not run.') }); } finally { setBusy(false); } };
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  const a = d.account;
  const count = (s) => d.templates.filter((t) => t.status === s).length;
  return (
    <div>
      <div className="oc-note">One Meta business account for the whole company. Every department uses the same account; each department has its own templates, campaigns, analytics and inbox view. This page only reads: the account itself is set up in {a.where}.</div>
      <section className="oc2-block"><h3 className="oc2-h">The connected account</h3>
        <div className="oc2-link"><span className={`oc2-dot ${a.connected ? 'green' : 'red'}`} aria-hidden="true" />
          <div><h4>{a.connected ? 'Connected' : 'Not connected'}{a.testServer ? ' (test server)' : ''}</h4>
            <ul><li>Number: {a.number || 'not saved'}</li><li>Phone ID: {a.phoneIdMasked || 'not saved'}; Business account ID: {a.businessIdMasked || 'not saved'}</li><li>App secret: {a.secretSaved ? 'saved' : 'not saved'}; webhook check word: {a.verifyTokenSaved ? 'saved' : 'not saved'}</li>{!a.connected && <li>{a.why}</li>}</ul>
            <div className="oc-row2"><button type="button" className="btn btn-sm" disabled={busy || !a.connected} onClick={check}>{busy ? 'Reading…' : 'Check name, quality and limit at Meta'}</button><span className="oc-note">Only reads. Nothing is sent.</span></div>
            {chk && <div className={chk.ok ? 'bc-ok' : 'bc-warn'} role="status">{chk.ok ? `${chk.name || 'WhatsApp'} ${chk.number}. Quality: ${chk.quality}. Message limit: ${chk.limit}.` : chk.words}{chk.ok ? ` ${chk.words}` : ''}</div>}
          </div></div>
      </section>
      <section className="oc2-block"><h3 className="oc2-h">Webhook (how replies and delivery ticks come back)</h3>
        <div className="oc2-link"><span className={`oc2-dot ${a.webhook.state}`} aria-hidden="true" />
          <div><div>Paste this link in Meta: <code>{a.webhook.url}</code></div>
            <div className="oc-note">{a.webhook.lastCall ? `Last call from Meta: ${fmt(a.webhook.lastCall)} (${a.webhook.calls} so far).` : 'Meta has not called it yet.'}{!a.webhook.hasPublicAddress ? ' The site public address (APP_BASE_URL) is not set, so the full link cannot be shown.' : ''}</div></div></div>
      </section>
      <Block b={{ id: 'r', title: 'Routing: which number each department uses', head: ['Department', 'WhatsApp', 'Goes through', 'Head'], rows: d.departments.rows.map((r) => [r.name, r.whatsapp ? 'On' : 'Off', r.whatsapp ? `The one connected number ${a.number || ''}`.trim() : 'WhatsApp is not used by this department', r.headName || '-']), note: 'One Meta account, one number today. A department can be switched off for WhatsApp in the Departments tab. Several numbers per department is planned, not built.' }} />
      <Block b={{ id: 't', title: 'WhatsApp templates and Meta approval', tiles: [{ label: 'Approved', value: count('Approved'), tone: 'g' }, { label: 'Waiting for WhatsApp', value: count('Pending'), tone: 'o' }, { label: 'Not sent for approval', value: count('None') }, { label: 'Rejected', value: count('Rejected'), tone: 'r' }], head: ['Template', 'Kind', 'Department', 'Meta name', 'Status'], rows: d.templates.map((t) => [t.name, t.kind, t.department, t.waName || '-', WA_WORD[t.status] || t.status]), note: 'Open Campaigns > Templates > Approval queue to change a status. We never mark a template Approved ourselves.' }} />
    </div>
  );
}

export function Departments() {
  const [d, setD] = useState(null);
  const [people, setPeople] = useState([]);
  const [rows, setRows] = useState([]);
  const [extra, setExtra] = useState([]);
  const [add, setAdd] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/outreach/config/meta').then((r) => { setD(r.data.departments); setRows(r.data.departments.rows); setExtra(r.data.departments.rows.filter((x) => !x.inMaster).map((x) => x.name)); }).catch((e) => setErr(errOf(e, 'The departments could not be loaded.'))), []);
  useEffect(() => { load(); api.get('/outreach/config/people').then((r) => setPeople(r.data.people)).catch(() => setPeople([])); }, [load]);
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  const setRow = (name, patch) => setRows(rows.map((r) => (r.name === name ? { ...r, ...patch } : r)));
  const addName = (n) => { const name = n.trim(); if (name.length < 2 || rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return; setRows([...rows, { name, inMaster: false, head: null, headName: '', whatsapp: true }]); setExtra([...extra, name]); setAdd(''); };
  const save = async () => { setErr(''); setMsg(''); try { const r = await api.put('/outreach/config/departments', { rows: rows.map((x) => ({ name: x.name, head: x.head, whatsapp: x.whatsapp })), extra }); setD(r.data); setRows(r.data.rows); setMsg('Saved.'); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  return (
    <div>
      <div className="oc-note">The list comes from the Department master (Administration). Each department has its own templates, campaigns, analytics and inbox view, all on the same Meta account. The head is shown for information; who counts as a Department Head in Omni-Channel follows the person&apos;s role.</div>
      {d.founderNames.some((f) => !f.inList) && <div className="bc-warn" role="status">These names are not in the list yet: {d.founderNames.filter((f) => !f.inList).map((f) => <button type="button" key={f.name} className="btn btn-sm" style={{ margin: '0 4px' }} onClick={() => addName(f.name)}>Add {f.name}</button>)}</div>}
      <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>Department</th><th>Head</th><th>Uses WhatsApp</th><th>Source</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.name}><td className="name">{r.name}</td>
            <td style={{ minWidth: 220 }}><Combo value={r.head || ''} onChange={(e) => setRow(r.name, { head: e.target.value || null })}><option value="">No head chosen</option>{people.map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.department ? ` (${p.department})` : ''}</option>)}</Combo></td>
            <td><label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={r.whatsapp} onChange={(e) => setRow(r.name, { whatsapp: e.target.checked })} /> {r.whatsapp ? 'Yes' : 'No'}</label></td>
            <td>{r.inMaster ? 'Department master' : 'Added here'}</td></tr>
        ))}</tbody></table></div>
      <div className="oc-bar"><input type="text" value={add} maxLength={60} onChange={(e) => setAdd(e.target.value)} placeholder="Add a department name" aria-label="New department" /><button type="button" className="btn" disabled={add.trim().length < 2} onClick={() => addName(add)}>Add</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </div>
  );
}

export function Permissions() {
  const [d, setD] = useState(null);
  const [people, setPeople] = useState([]);
  const [ids, setIds] = useState([]);
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/outreach/config/permissions').then((r) => { setD(r.data); setIds(r.data.marketing.map((m) => m.userId)); }).catch((e) => setErr(errOf(e, 'The permissions could not be loaded.'))), []);
  useEffect(() => { load(); api.get('/outreach/config/people').then((r) => setPeople(r.data.people)).catch(() => setPeople([])); }, [load]);
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  const nameOf = (id) => (people.find((p) => p.userId === id) || d.marketing.find((m) => m.userId === id) || {}).name || id;
  const save = async () => { setErr(''); setMsg(''); try { await api.put('/outreach/config/permissions/marketing', { userIds: ids }); setMsg('Saved.'); load(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  const HUBW = { dashboard: 'Dashboard', communication: 'Communication', campaigns: 'Campaigns', insights: 'Insights', configuration: 'Configuration' };
  const yes = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '-') : (v ? 'Yes' : '-'));
  return (
    <div>
      <Block b={{ id: 'm', title: 'Who opens which hub', head: ['Role', ...Object.values(HUBW)], rows: d.matrix.map((m) => [m.words, ...Object.keys(HUBW).map((k) => yes(m.hubs[k]))]), note: 'Read only: made from the real rules in the server. Insights shows the tabs that role may open. A Department Head sees the whole department; a Team Lead sees the team; a Recruiter only their own numbers.' }} />
      <section className="oc2-block"><h3 className="oc2-h">What each part of Omni-Channel lets a role do</h3><Roles /></section>
      <section className="oc2-block"><h3 className="oc2-h">Marketing capability</h3>
        <div className="oc-note">{d.marketingWords}</div>
        <div className="oc-choice">{ids.length === 0 && <span className="oc-note">Nobody has it.</span>}{ids.map((id) => <button type="button" key={id} onClick={() => setIds(ids.filter((x) => x !== id))} title="Take it away">{nameOf(id)} (remove)</button>)}</div>
        <div className="oc-bar"><div style={{ minWidth: 280 }}><Combo value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose a person to give it to</option>{people.filter((p) => !ids.includes(p.userId)).map((p) => <option key={p.userId} value={p.userId}>{p.name}{p.department ? ` (${p.department})` : ''}</option>)}</Combo></div>
          <button type="button" className="btn" disabled={!pick} onClick={() => { setIds([...ids, pick]); setPick(''); }}>Give it</button><button type="button" className="btn btn-primary" onClick={save}>Save</button></div>
        {msg && <div className="bc-ok" role="status">{msg}</div>}
        {err && <div className="bc-err" role="alert">{err}</div>}
      </section>
      <section className="oc2-block"><h3 className="oc2-h">Credit rules</h3><CreditsSettings /></section>
    </div>
  );
}

export function ConfigSettings() {
  return (
    <div>
      <section className="oc2-block"><h3 className="oc2-h">Test mode and sending speed</h3><div className="oc-note">Test mode is ON until you switch it off: campaign emails are only rehearsed.</div><SendingSettings onChanged={() => {}} /></section>
      <section className="oc2-block"><h3 className="oc2-h">Sender identities</h3><SenderDetails /></section>
      <section className="oc2-block"><h3 className="oc2-h">Quiet hours and the same-requirement rule</h3><SendingRules /></section>
      <section className="oc2-block"><h3 className="oc2-h">Consent log</h3><ConsentLog /></section>
    </div>
  );
}

export function ChannelsConfig() {
  return (
    <div>
      <section className="oc2-block"><h3 className="oc2-h">Email, WhatsApp, SMS and Call</h3><Channels /></section>
      <section className="oc2-block"><h3 className="oc2-h">Links to HRMS, ATS, Accounts and the Job Portal</h3><Connections /></section>
    </div>
  );
}
