import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';

// ---------------------------------------------------------------------------
// OMNI-CHANNEL > SETTINGS (Admin only; the server refuses everyone else). Channels lives in Channels.jsx.
//   Sender details   From email / From name / Reply-to, the WhatsApp business number (shown only), SMS sender ID + DLT entity number
//   Sending rules    "same job again after N days" and QUIET HOURS (India time; OFF until an Admin turns it ON)
//   Consent log      read-only list of every opt-in / opt-out / unsubscribe / STOP (nothing can be deleted); Download is Admin only and audited
//   Roles            a read-only "who can see what" table made from the real access rules
// ---------------------------------------------------------------------------
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const errOf = (e, fb) => (e && e.response && e.response.data && e.response.data.error) || fb;

// ---------------------------------------------------------------- sender details
export function SenderDetails() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/outreach/sender-details').then((r) => { setD(r.data); setF({ ...r.data.details, whatsappNumber: r.data.details.whatsappShown || r.data.details.whatsappNumber }); }).catch((e) => setErr(errOf(e, 'The sender details could not be loaded.'))), []);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setErr(''); setMsg('');
    try {
      await api.put('/outreach/settings', { fromEmail: f.fromEmail, fromName: f.fromName, replyTo: f.replyTo, whatsappNumber: f.whatsappNumber, smsSenderId: f.smsSenderId, smsDltEntityId: f.smsDltEntityId });
      setMsg('Saved.'); await load();
    } catch (e2) { setErr(errOf(e2, 'It could not be saved.')); }
  };
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d || !f) return <div className="oc-note">Loading…</div>;
  const fromLine = `${f.fromName || 'TeamLink'}${f.fromEmail ? ` <${f.fromEmail}>` : ''}`;
  return (
    <div className="oc-split">
      <div className="oc-card">
        <h4>Who the messages come from</h4>
        <div className="oc-note">Used when you write a message and see how it will look. The mail server itself is set up in Administration &gt; Integrations.</div>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <label className="field"><span>From email</span><input value={f.fromEmail} inputMode="email" maxLength={160} onChange={set('fromEmail')} placeholder="jobs@yourcompany.in" /></label>
          <label className="field"><span>From name</span><input value={f.fromName} maxLength={80} onChange={set('fromName')} placeholder="TeamLink Jobs" /></label>
          <label className="field"><span>Replies go to</span><input value={f.replyTo} inputMode="email" maxLength={160} onChange={set('replyTo')} placeholder="jobs@yourcompany.in" /></label>
          <label className="field"><span>WhatsApp business number</span><input value={f.whatsappNumber} inputMode="tel" maxLength={30} onChange={set('whatsappNumber')} placeholder="+91 98765 43210" /></label>
          <label className="field"><span>SMS sender ID (6 letters)</span><input value={f.smsSenderId} maxLength={6} onChange={(e) => setF({ ...f, smsSenderId: e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase() })} placeholder="TEAMLK" /></label>
          <label className="field"><span>SMS DLT entity number</span><input value={f.smsDltEntityId} inputMode="numeric" maxLength={25} onChange={(e) => setF({ ...f, smsDltEntityId: e.target.value.replace(/\D/g, '') })} /></label>
        </div>
        <div className="oc-note">WhatsApp and SMS sending come later. The number and the IDs are only saved and shown for now.</div>
        <div className="oc-row2"><button type="button" className="btn btn-primary" onClick={save}>Save sender details</button></div>
        {msg && <div className="bc-ok" role="status">{msg}</div>}
        {err && <div className="bc-err" role="alert">{err}</div>}
      </div>
      <div className="oc-card">
        <h4>How it looks on a message</h4>
        <div className="oc-prev"><b>Email</b>{'\n'}From: {fromLine}{f.replyTo ? `\nReplies go to: ${f.replyTo}` : ''}{'\n\n'}<b>WhatsApp</b>{'\n'}{f.whatsappNumber ? `Sent from ${f.whatsappNumber}` : 'No number saved yet'}{'\n\n'}<b>SMS</b>{'\n'}{f.smsSenderId ? `Sender ID ${f.smsSenderId}` : 'No sender ID saved yet'}{f.smsDltEntityId ? `\nDLT entity ${f.smsDltEntityId}` : ''}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sending rules
export function SendingRules() {
  const [d, setD] = useState(null);
  const [days, setDays] = useState('');
  const [q, setQ] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api.get('/outreach/sender-details').then((r) => { setD(r.data); setDays(String(r.data.suppressDays)); setQ(r.data.quietHours); }).catch((e) => setErr(errOf(e, 'The rules could not be loaded.'))), []);
  useEffect(() => { load(); }, [load]);
  const put = async (body, ok) => { setErr(''); setMsg(''); try { await api.put('/outreach/settings', body); setMsg(ok); await load(); } catch (e) { setErr(errOf(e, 'It could not be saved.')); } };
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d || !q) return <div className="oc-note">Loading…</div>;
  return (
    <div className="oc-cards" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
      <div className="oc-card">
        <h4>Same requirement again</h4>
        <div className="oc-note">Do not message the same person about the same requirement again for this many days.</div>
        <label className="field" style={{ marginTop: 8 }}><span>Days</span><input value={days} inputMode="numeric" maxLength={3} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></label>
        <div className="oc-row2"><button type="button" className="btn btn-primary" onClick={() => put({ suppressDays: Number(days || 0) }, 'Saved.')}>Save</button></div>
      </div>
      <div className="oc-card">
        <h4>Quiet hours</h4>
        {q.enabled ? <span className="oc-pill in">ON</span> : <span className="oc-pill">OFF: messages can go out at any hour</span>}
        <div className="oc-note" style={{ marginTop: 6 }}>Never send at night. Promotion messages wait until quiet hours end, then go out by themselves. India time.</div>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <label className="field"><span>Quiet from</span><input type="time" value={q.start} onChange={(e) => setQ({ ...q, start: e.target.value })} /></label>
          <label className="field"><span>Until</span><input type="time" value={q.end} onChange={(e) => setQ({ ...q, end: e.target.value })} /></label>
        </div>
        <div className="oc-tick" style={{ margin: '6px 0' }}><label><input type="checkbox" checked={q.applyInternal} onChange={(e) => setQ({ ...q, applyInternal: e.target.checked })} /> Apply to internal messages too (messages to staff)</label></div>
        <div className="oc-row2">
          <button type="button" className="btn btn-primary" onClick={() => put({ quietHours: { start: q.start, end: q.end, applyInternal: q.applyInternal } }, 'Saved.')}>Save times</button>
          {q.enabled
            ? <button type="button" className="btn" onClick={() => put({ quietHours: { enabled: false } }, 'Quiet hours are OFF.')}>Turn quiet hours OFF</button>
            : <button type="button" className="btn" onClick={() => put({ quietHours: { start: q.start, end: q.end, applyInternal: q.applyInternal, enabled: true } }, 'Quiet hours are ON.')}>Turn quiet hours ON</button>}
        </div>
        <div className="oc-note">{d.quietWords}</div>
        <div className="oc-note">A campaign you schedule inside quiet hours starts when quiet hours end. A message that is due at night waits and says "Waiting for quiet hours to end".</div>
      </div>
      {msg && <div className="bc-ok" role="status">{msg}</div>}
      {err && <div className="bc-err" role="alert">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- consent log
const WHAT = [['', 'All events'], ['opt_in', 'Opted in'], ['opt_out', 'Opted out'], ['unsubscribe', 'Unsubscribed (link)'], ['stop', 'Replied STOP'], ['erasure', 'Removed at their request']];
export function ConsentLog() {
  const [f, setF] = useState({ q: '', action: '', channel: '', type: '', from: '', to: '', page: 1 });
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback((ff) => {
    setErr('');
    api.get('/outreach/consent-log', { params: { q: ff.q || undefined, action: ff.action || undefined, channel: ff.channel || undefined, type: ff.type || undefined, from: ff.from || undefined, to: ff.to || undefined, page: ff.page } })
      .then((r) => setD(r.data)).catch((e) => { setErr(errOf(e, 'The consent log could not be opened.')); setD({ events: [], total: 0, counts: {}, page: 1, pageSize: 50 }); });
  }, []);
  useEffect(() => { const t = setTimeout(() => load(f), f.q ? 250 : 0); return () => clearTimeout(t); }, [f, load]);
  const upd = (p) => setF((x) => ({ ...x, page: 1, ...p }));
  const download = async () => {
    try { const r = await api.get('/outreach/consent-log/export', { params: { q: f.q || undefined, action: f.action || undefined, channel: f.channel || undefined, type: f.type || undefined, from: f.from || undefined, to: f.to || undefined }, responseType: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'outreach-consent-log.csv'; a.click(); } catch (e) { setErr('You cannot download the consent log.'); }
  };
  const n = (k) => (d && d.counts && d.counts[k]) || 0;
  return (
    <div>
      <div className="oc-note">Every time someone said yes or no to a message. It is a record: nothing here can be changed or deleted.</div>
      <div className="oc-bar">
        <input type="search" placeholder="Search a name, a source or a reason" value={f.q} onChange={(e) => upd({ q: e.target.value })} aria-label="Search the consent log" />
        {d && d.canExport && <button type="button" className="btn" onClick={download}>Download CSV</button>}
      </div>
      <div className="oc-filters">
        <div><label>What happened</label><Combo value={f.action} onChange={(e) => upd({ action: e.target.value })}>{WHAT.map(([v, l]) => <option key={v} value={v}>{v ? `${l} (${n(v)})` : l}</option>)}</Combo></div>
        <div><label>Channel</label><Combo value={f.channel} onChange={(e) => upd({ channel: e.target.value })}><option value="">All channels</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></Combo></div>
        <div><label>Who</label><Combo value={f.type} onChange={(e) => upd({ type: e.target.value })}><option value="">Candidate contacts and staff</option><option value="promo">Candidate contacts</option><option value="internal">Staff</option></Combo></div>
        <div><label>From day</label><input type="date" value={f.from} onChange={(e) => upd({ from: e.target.value })} /></div>
        <div><label>To day</label><input type="date" value={f.to} onChange={(e) => upd({ to: e.target.value })} /></div>
      </div>
      {err && <div className="bc-err" role="alert">{err}</div>}
      {!d && <div className="oc-note">Loading…</div>}
      {d && d.events.length === 0 && !err && <div className="oc-empty"><b>No events match.</b><div>When people opt in, opt out or reply STOP, they will show here.</div></div>}
      {d && d.events.length > 0 && (
        <>
          <div className="oc-scroll"><table className="oc-table"><thead><tr><th>When</th><th>What happened</th><th>Channel</th><th>Person</th><th className="oc-hide-m">Who did it</th><th className="oc-hide-m">Source</th><th>Why</th></tr></thead><tbody>
            {d.events.map((e) => (
              <tr key={e.id}><td>{when(e.at)}</td><td><span className={`oc-pill ${e.action === 'opt_in' ? 'in' : 'out'}`}>{e.actionWords}</span></td><td>{e.channelWords}</td>
                <td><b>{e.name}</b><div className="oc-note">{[e.contact, e.kind].filter(Boolean).join(' · ')}</div></td><td className="oc-hide-m">{e.who}</td><td className="oc-hide-m">{e.sourceWords}</td><td className="oc-note">{e.why}</td></tr>
            ))}
          </tbody></table></div>
          <div className="oc-bar">
            <button type="button" className="btn btn-sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Back</button>
            <span className="oc-note">{`Page ${d.page} · ${d.total.toLocaleString('en-IN')} events`}</span>
            <button type="button" className="btn btn-sm" disabled={d.page * d.pageSize >= d.total} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- roles
export function Roles() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/outreach/roles').then((r) => setD(r.data)).catch((e) => setErr(errOf(e, 'The roles could not be loaded.'))); }, []);
  if (err) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  return (
    <div>
      <div className="oc-note">Who can see and do what in Omni-Channel. This table is read-only: it is made from the real rules the server uses.</div>
      <div className="oc-scroll" style={{ marginTop: 8 }}><table className="oc-table oc-roles"><thead><tr><th>What</th>{d.roles.map((r) => <th key={r.kind}>{r.words}</th>)}</tr></thead><tbody>
        {d.rows.map((row) => <tr key={row.id}><td>{row.words}</td>{d.roles.map((r) => <td key={r.kind} className={row.allowed[r.kind] ? 'oc-yes' : 'oc-no'}>{row.allowed[r.kind] ? 'Yes' : '—'}</td>)}</tr>)}
      </tbody></table></div>
      <ul className="oc-note" style={{ marginTop: 8 }}>{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      <div className="oc-note">Roles themselves (who is a BDE, a Team Lead ...) are edited in the Role Catalog under Administration.</div>
    </div>
  );
}
