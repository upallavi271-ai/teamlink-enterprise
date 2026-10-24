import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import InboxPanel from '../messaging/InboxPanel.jsx';
import { CHANNEL_OF } from './omniNav.js';
import './omni2.css';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > COMMUNICATION (Engagement Hub). Inbox = every open reply; Conversations = every chat, open or done; WhatsApp / SMS / Email / Calls =
// the SAME inbox opened on that way, plus that way's status, one-message box and what was sent. All data is the app's one inbox
// (/api/conversations) and the credit ledger (/api/outreach/communication/log). Nothing is stored twice.
// ---------------------------------------------------------------------------
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '');

function Status({ channel }) {
  const [c, setC] = useState(null);
  useEffect(() => { api.get('/conversations/channels').then((r) => setC(r.data.channels[channel] || null)).catch(() => setC(null)); }, [channel]);
  if (!c) return null;
  return (
    <div className="oc2-link" style={{ marginBottom: 10 }}>
      <span className={`oc2-dot ${c.configured ? 'green' : 'red'}`} aria-hidden="true" />
      <div><b>{channel === 'Call' ? 'Calls' : channel}: {c.configured ? 'Connected' : 'Not connected'}</b><div className="oc-note">{c.configured ? (c.detail || '') : (c.reason || 'Not connected yet.')}{channel === 'Email' && c.repliesHint ? ` ${c.repliesHint}.` : ''}</div></div>
    </div>
  );
}

function SendBox({ acc, channel }) {
  const way = channel.toLowerCase();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState(null);
  const [tpls, setTpls] = useState([]);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const may = acc.canCampaign || acc.isAdmin || acc.canCampaignInternal;
  useEffect(() => { if (!may) return undefined; const t = setTimeout(() => { if (q.trim().length < 2) { setPeople([]); return; } api.get('/outreach/contacts', { params: { q, pageSize: 8, type: acc.seesLeads ? 'candidate_lead' : 'internal' } }).then((r) => setPeople(r.data.contacts || [])).catch(() => setPeople([])); }, 250); return () => clearTimeout(t); }, [q, may, acc.seesLeads]);
  useEffect(() => { if (may) api.get('/outreach/hub/templates', { params: { channel } }).then((r) => setTpls((r.data.items || []).filter((i) => i.source === 'message' || i.source === 'outreach'))).catch(() => setTpls([])); }, [channel, may]);
  if (!may) return <div className="oc-note" style={{ marginBottom: 10 }}>Sending one message from here is for the BDE team, Team Leads, HR (when an Admin allows it) and Admins. You reply to people in the chat list below.</div>;
  const send = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await api.post('/outreach/communication/send', { contactId: pick.id, channel: way, text, templateLabel: label }); setMsg(r.data.ok); setText(''); } catch (e) { setErr(errOf(e, 'It could not be sent.')); } finally { setBusy(false); }
  };
  return (
    <div className="oc2-block">
      <h3 className="oc2-h">Send one {channel} message</h3>
      <div className="oc2-rule">
        <label className="field"><span>Find the person (type 2 letters)</span><input value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} placeholder="Name, city or skill" /></label>
        <div className="field"><span>Start from a template (optional)</span>
          <Combo value="" onChange={(e) => { const t = tpls.find((x) => x.key === e.target.value); if (t) { setText(t.body); setLabel(t.name); } }}><option value="">No template</option>{tpls.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</Combo>
        </div>
      </div>
      {!pick && people.length > 0 && <div className="oc-choice">{people.map((p) => <button type="button" key={p.id} onClick={() => { setPick(p); setPeople([]); }}>{p.name || 'No name'}{p.city ? `, ${p.city}` : ''}</button>)}</div>}
      {pick && <div className="oc-note">To: <b>{pick.name || 'this person'}</b> (their number and email stay hidden unless your role may see them)</div>}
      <label className="field"><span>Message</span><textarea className="oc-text" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div className="oc-row2"><button type="button" className="btn btn-primary" disabled={busy || !pick || !text.trim()} onClick={send}>{busy ? 'Working…' : 'Send'}</button><span className="oc-note">Only people who agreed to {channel} messages can get one. In Test mode nothing is really sent.</span></div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </div>
  );
}

function SentLog({ channel }) {
  const way = channel.toLowerCase();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.get('/outreach/communication/log', { params: { channel: way } }).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'The list could not be loaded.'))), [way]);
  useEffect(() => { load(); }, [load]);
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  return (
    <div className="oc2-block">
      <h3 className="oc2-h">{channel === 'Call' ? 'Calls logged' : `What was sent on ${channel}`}</h3>
      <div className="oc-note">{d.scopeWords}. Every send of the app is listed here (campaigns, screens, automations). Message words and addresses are never shown.</div>
      {d.rows.length === 0 ? <div className="oc-note" style={{ marginTop: 6 }}>Nothing yet.</div> : (
        <div className="oc-scroll oc2-act"><table className="oc2-table"><thead><tr><th>When</th><th>By</th><th>Department</th><th>Came from</th><th>Template</th><th>Result</th></tr></thead>
          <tbody>{d.rows.map((r, i) => <tr key={i}><td>{fmt(r.at)}</td><td className="name">{r.who}</td><td>{r.department}</td><td>{r.from}</td><td>{r.template}</td><td>{r.result}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

export default function Communication({ acc, tab }) {
  if (tab === 'inbox') return <div><div className="oc-note" style={{ marginBottom: 8 }}>Every reply that is waiting. Open one to read the chat, reply with a template, mark it done or give it to a colleague. You only see your own people and department.</div><InboxPanel /></div>;
  if (tab === 'conversations') return <div><div className="oc-note" style={{ marginBottom: 8 }}>Every chat with a person, open or finished, across all ways (WhatsApp, SMS, Email, calls).</div><InboxPanel state="all" /></div>;
  const channel = CHANNEL_OF[tab];
  if (!channel) return null;
  return (
    <div>
      <Status channel={channel} />
      {channel !== 'Call' && <SendBox acc={acc} channel={channel} />}
      {channel === 'Call' && <div className="oc-note" style={{ marginBottom: 8 }}>Calls are made from a person&apos;s card ("Call through TeamLink" or the phone link). Each call is saved here with how it went. AI calling is planned, not built.</div>}
      <div className="oc2-block"><h3 className="oc2-h">{channel === 'Call' ? 'Call chats' : `${channel} chats`}</h3><InboxPanel channel={channel} state="all" /></div>
      <SentLog channel={channel} />
    </div>
  );
}
