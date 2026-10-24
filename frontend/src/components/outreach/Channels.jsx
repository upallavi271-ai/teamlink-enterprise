import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';

const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const STATUS = { test_captured: 'Test (not sent)', sent: 'Sent', refused: 'Not sent', failed: 'Failed' };
const REASON = { opted_out: 'opted out', suppressed: 'do-not-contact', no_opt_in: 'no permission', daily_cap: 'daily limit reached', internal_contact: 'internal contact', no_unsubscribe_link: 'no unsubscribe link', no_address: 'no address', bad_address: 'bad address' };

// what WhatsApp and SMS need before they can be switched on (shown on their "Coming later" cards)
const LATER = {
  whatsapp: 'Coming later. WhatsApp must approve every message template first (you can already write templates and note their approval). Needs a WhatsApp Business number: save it in Settings > Sender details.',
  sms: 'Coming later. Indian SMS needs a registered DLT sender ID and a DLT number for every template. You can already save them in Settings > Sender details and on each template.',
};

export default function Channels() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [cap, setCap] = useState('');
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => api.get('/outreach/channels').then((r) => { setD(r.data); setCap(String(r.data.settings.emailDailyCap)); setFromName(r.data.settings.fromName || ''); setReplyTo(r.data.settings.replyTo || ''); }).catch((e) => setErr(e.response?.data?.error || 'The channels could not be loaded.')), []);
  useEffect(() => { load(); }, [load]);
  const put = async (body, okText) => { setErr(''); setMsg(''); try { const r = await api.put('/outreach/settings', body); setMsg(okText || r.data.ok); setConfirm(false); await load(); } catch (e) { setErr(e.response?.data?.error || 'It could not be saved.'); } };
  if (err && !d) return <div className="bc-err" role="alert">{err}</div>;
  if (!d) return <div className="oc-note">Loading…</div>;
  const email = d.channels.find((c) => c.channel === 'email');
  return (
    <div>
      <div className="oc-note">Passwords and keys stay in <Link to="/admin/integrations">Administration &gt; Integrations</Link>. They are never shown here.</div>
      <div className="oc-cards" style={{ marginTop: 8 }}>
        {d.channels.map((c) => (
          <div className="oc-card" key={c.channel}>
            <h4>{c.label}</h4>
            {c.channel === 'email'
              ? (c.testMode ? <span className="oc-pill">Test mode: nothing is sent</span> : <span className="oc-pill in">Live: real emails go out</span>)
              : <span className="oc-pill">Coming later</span>}
            <div className="oc-note" style={{ marginTop: 6 }}>{c.channel === 'email' ? (c.ready ? 'Set up in Integrations.' : c.reason) : LATER[c.channel]}</div>
            {c.channel === 'email' && <div className="oc-note">Today: {c.sentToday} of {c.dailyCap} allowed.</div>}
          </div>
        ))}
      </div>
      <div className="oc-card" style={{ marginTop: 12 }}>
        <h4>Email settings</h4>
        {email.testMode
          ? <div className="bc-ok">Test mode is ON. Messages are prepared and written to the list below, but nobody receives anything.</div>
          : <div className="bc-warn">Test mode is OFF. Real people will get emails.</div>}
        <div className="grid-2">
          <label className="field"><span>Most emails per day</span><input value={cap} inputMode="numeric" onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} /></label>
          <label className="field"><span>Sender name</span><input value={fromName} maxLength={80} onChange={(e) => setFromName(e.target.value)} placeholder="TeamLink Jobs" /></label>
          <label className="field"><span>Replies go to</span><input value={replyTo} maxLength={160} onChange={(e) => setReplyTo(e.target.value)} placeholder="jobs@yourcompany.in" /></label>
        </div>
        <div className="oc-row2"><button type="button" className="btn btn-primary" onClick={() => put({ emailDailyCap: Number(cap || 0), fromName, replyTo }, 'Saved.')}>Save settings</button></div>
        <div style={{ borderTop: '1px solid var(--line,#e3e8f0)', marginTop: 10, paddingTop: 10 }}>
          {email.testMode ? (
            <>
              <div className="oc-tick"><label><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand real people will get emails</label></div>
              <button type="button" className="btn" disabled={!confirm || !email.ready} onClick={() => put({ emailTestMode: false, confirmLive: true }, 'Real sending is on.')}>Switch to real sending</button>
              {!email.ready && <div className="oc-note">First set up Email in Administration &gt; Integrations.</div>}
            </>
          ) : <button type="button" className="btn" onClick={() => put({ emailTestMode: true }, 'Back in test mode. Nothing is sent.')}>Back to test mode</button>}
        </div>
        {msg && <div className="bc-ok" role="status" style={{ marginTop: 8 }}>{msg}</div>}
        {err && <div className="bc-err" role="alert">{err}</div>}
      </div>
      <h4 style={{ margin: '14px 0 6px' }}>Latest messages</h4>
      {d.log.length === 0 ? <div className="oc-empty">Nothing yet. Messages will show here when the next step starts sending.</div> : (
        <div className="oc-scroll"><table className="oc-table"><thead><tr><th>When</th><th>To</th><th>What</th><th>Result</th></tr></thead><tbody>
          {d.log.map((l) => <tr key={l.id}><td>{when(l.at)}</td><td>{l.toMasked}</td><td>{l.subject}</td><td>{STATUS[l.status] || l.status}{l.reason ? ` (${REASON[l.reason] || l.reason})` : ''}</td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}
