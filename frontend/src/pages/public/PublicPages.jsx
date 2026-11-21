import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../api';
import { t, useLang, LanguagePicker } from '../../i18n.jsx';
import '../offerSigning.css';

// ---------------------------------------------------------------------------
// PUBLIC PAGES of the market wave (2026-11-21), no login:
//   /preboarding/:token   the candidate's pre-boarding page (11.09 / 11.18): welcome, steps, uploads, forms - English / Telugu / Hindi
//   /status               the live status page and uptime (15.12)
//   /trust                the trust centre: security practices, where data is stored, certifications not held (15.12 / 15.11)
//   /sla                  the uptime and support targets against the measured uptime (15.16)
//   /privacy-notice       the DPDP notice in English, Telugu and Hindi (15.09)
// Backend: routes/atsPlusPublic.js.
// ---------------------------------------------------------------------------
const say = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const ST = { OPEN: 'To do', SUBMITTED: 'Waiting for review', DONE: 'Done', VERIFIED: 'Verified', SENT_BACK: 'Sent back', WAIVED: 'Not needed' };
function Shell({ title, children }) {
  return (
    <div className="careers-shell"><main className="ofs-page">
      <div className="ofs-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}><h1 style={{ flex: 1 }}>{title}</h1><LanguagePicker compact /></div>
      {children}
    </main></div>
  );
}

function Step({ token, it, onDone }) {
  const [file, setFile] = useState(null); const [vals, setVals] = useState(it.values || {}); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const go = async (fn) => { setBusy(true); setMsg(null); try { const r = await fn(); setMsg({ ok: true, text: t(r.data.message || 'Thank you. Your recruiter will check it.') }); onDone(); } catch (e) { setMsg({ ok: false, text: say(e, 'Could not save. Please try again.') }); } finally { setBusy(false); } };
  const upload = () => { const fd = new FormData(); fd.append('file', file); return go(() => api.post(`/public/preboarding/${token}/items/${it.key}/upload`, fd)); };
  const done = ['DONE', 'VERIFIED', 'WAIVED'].includes(it.status);
  return (
    <div className="agr-card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ flex: 1 }}>{it.label}</b><span className="small-muted">{t(ST[it.status] || it.status)}</span></div>
      {it.note && <div className="notice amber" style={{ margin: '6px 0' }}>{it.note}</div>}
      {!done && it.type === 'doc' && (
        <div style={{ marginTop: 6 }}>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.docx" aria-label={t('Choose a file')} onChange={(e) => setFile(e.target.files[0] || null)} />
          <button type="button" className="btn btn-primary btn-sm" disabled={!file || busy} onClick={upload}>{t('Upload')}</button>
          <div className="small-muted">{t('PDF, JPG, PNG or DOCX, up to 10 MB.')}</div>
        </div>
      )}
      {!done && it.type === 'form' && (
        <div style={{ marginTop: 6 }}>
          {(it.fields || []).map((f) => <label key={f.key} className="field"><span>{f.label}</span><input value={vals[f.key] || ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} /></label>)}
          {(it.fields || []).some((f) => /aadhaar|aadhar/i.test(`${f.key} ${f.label}`)) && <div className="small-muted">{t('Aadhaar: only the last 4 digits are kept.')}</div>}
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => go(() => api.post(`/public/preboarding/${token}/items/${it.key}/done`, { values: vals }))}>{t('Send')}</button>
        </div>
      )}
      {!done && it.type === 'task' && it.status !== 'SUBMITTED' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => go(() => api.post(`/public/preboarding/${token}/items/${it.key}/done`, {}))}>{t('Mark as done')}</button>}
      {msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`} style={{ marginTop: 6 }}>{msg.text}</div>}
    </div>
  );
}
export function PreboardingPage() {
  const { token } = useParams();
  useLang();
  const [v, setV] = useState(null); const [fatal, setFatal] = useState('');
  const load = useCallback(() => api.get(`/public/preboarding/${token}`).then((r) => setV(r.data)).catch((e) => setFatal(say(e, t('This link does not work. Ask your recruiter for a new one.')))), [token]);
  useEffect(() => { load(); }, [load]);
  if (fatal) return <Shell title="TeamLink"><div className="notice red" role="alert">{fatal}</div></Shell>;
  if (!v) return <Shell title="TeamLink"><div className="small-muted">{t('Loading…')}</div></Shell>;
  const w = v.welcome || {};
  return (
    <Shell title={t('Welcome, {name}!', { name: v.firstName || '' })}>
      {w.text && <p>{w.text}</p>}
      <section className="ofs-facts" aria-label={t('Your first day')}>
        <div><span>{t('Job')}</span><b>{v.job}</b></div>
        <div><span>{t('Joining date')}</span><b>{day(w.firstDay || v.joiningDate) || '—'}</b></div>
        {w.time && <div><span>{t('Time')}</span><b>{w.time}</b></div>}
        {w.place && <div><span>{t('Where')}</span><b>{w.place}</b></div>}
        {w.meet && <div><span>{t('Whom to meet')}</span><b>{w.meet}</b></div>}
      </section>
      <h3 style={{ marginTop: 16 }}>{t('Before your first day')}</h3>
      <div className="small-muted" style={{ marginBottom: 8 }}>{t('{done} of {of} done', { done: v.items.filter((i) => ['DONE', 'VERIFIED', 'WAIVED', 'SUBMITTED'].includes(i.status)).length, of: v.items.length })}</div>
      {v.items.map((it) => <Step key={it.key} token={token} it={it} onDone={load} />)}
      <p className="small-muted"><Link to="/privacy-notice">{t('Privacy notice')}</Link></p>
    </Shell>
  );
}

const pct = (u) => (u && u.pct !== null && u.pct !== undefined ? `${u.pct}%` : 'not measured yet');
export function StatusPage() {
  const [d, setD] = useState(null); const [e, setE] = useState('');
  useEffect(() => { api.get('/public/status').then((r) => setD(r.data)).catch((x) => setE(say(x, 'The status page is not available.'))); }, []);
  return (
    <Shell title="TeamLink status">
      {e && <div className="notice red">{e}</div>}
      {d && <>
        <div className={`notice ${d.overall.startsWith('All') ? 'green' : 'amber'}`}><b>{d.overall}</b> · checked {new Date(d.at).toLocaleString('en-GB')}</div>
        {d.components.map((c) => <div key={c.name} className="kv"><span className="k">{c.name}</span><span>{c.ok ? 'Working' : 'Problem'}{c.ms !== undefined && c.ms !== null ? ` (${c.ms} ms)` : ''}</span></div>)}
        <h3 style={{ marginTop: 14 }}>Uptime</h3>
        <div className="kv"><span className="k">Last 24 hours</span><span>{pct(d.uptime.day)}</span></div>
        <div className="kv"><span className="k">Last 7 days</span><span>{pct(d.uptime.week)}</span></div>
        <div className="kv"><span className="k">Last 30 days</span><span>{pct(d.uptime.month)}</span></div>
        <div className="kv"><span className="k">Last 90 days</span><span>{pct(d.uptime.quarter)}</span></div>
        <div style={{ display: 'flex', gap: 2, margin: '10px 0', flexWrap: 'wrap' }} aria-label="Uptime by day">
          {d.daily.map((x) => <span key={x.day} title={`${x.day}: ${x.pct}%`} style={{ width: 6, height: 24, borderRadius: 2, background: x.pct >= 99.5 ? '#1d9b5a' : x.pct >= 95 ? '#d97706' : '#dc2626' }} />)}
        </div>
        <h3>Recent incidents</h3>
        {d.incidents.length ? d.incidents.map((i) => <div key={i.since} className="small-muted">Down from {new Date(i.since).toLocaleString('en-GB')} to {new Date(i.upAt).toLocaleString('en-GB')}</div>) : <div className="small-muted">No incidents recorded.</div>}
        <p className="small-muted"><Link to="/trust">Trust centre</Link> · <Link to="/sla">Uptime and support targets</Link></p>
      </>}
    </Shell>
  );
}
export function TrustPage() {
  const [d, setD] = useState(null); const [e, setE] = useState('');
  useEffect(() => { api.get('/public/trust').then((r) => setD(r.data)).catch((x) => setE(say(x, 'The trust page is not available.'))); }, []);
  return (
    <Shell title="TeamLink trust centre">
      {e && <div className="notice red">{e}</div>}
      {d && <>
        <h3>How your data is protected</h3>
        {d.practices.map((p) => <div key={p.title} className="agr-card" style={{ marginBottom: 8 }}><b>{p.title}</b><div>{p.text}</div></div>)}
        <h3>Where the data is stored</h3>
        <div className="kv"><span className="k">Data</span><span>{[d.residency.region, d.residency.city, d.residency.provider].filter(Boolean).join(' · ')}</span></div>
        <div className="kv"><span className="k">Backups</span><span>{[d.residency.backupLocation, d.residency.backupProvider].filter(Boolean).join(' · ')}</span></div>
        <div className="small-muted">{d.residency.processors}</div>
        {d.residency.confirmedAt && <div className="small-muted">Confirmed {day(d.residency.confirmedAt)}.</div>}
        <h3>Certifications</h3>
        {d.certifications.map((c) => <div key={c.name} className="kv"><span className="k">{c.name}</span><span>{c.status}</span></div>)}
        <p className="small-muted"><Link to="/privacy-notice">Privacy notice</Link> · <Link to="/status">Status</Link> · <Link to="/sla">Uptime and support targets</Link> · uptime last 30 days: {pct(d.month)}</p>
      </>}
    </Shell>
  );
}
export function SlaPage() {
  const [d, setD] = useState(null); const [e, setE] = useState('');
  useEffect(() => { api.get('/public/sla').then((r) => setD(r.data)).catch((x) => setE(say(x, 'The page is not available.'))); }, []);
  return (
    <Shell title="Uptime and support">
      {e && <div className="notice red">{e}</div>}
      {d && <>
        <div className="kv"><span className="k">Uptime target</span><span>{d.uptimeTarget}% a month</span></div>
        <div className="kv"><span className="k">Measured, last 30 days</span><span>{pct(d.measured.month)}{d.met === null ? '' : d.met ? ' - target met' : ' - below target'}</span></div>
        <div className="kv"><span className="k">Measured, last 90 days</span><span>{pct(d.measured.quarter)}</span></div>
        <div className="kv"><span className="k">Support hours</span><span>{d.supportHours}</span></div>
        {Object.entries(d.response).map(([k, v]) => <div key={k} className="kv"><span className="k">First answer, {k === 'P1' ? 'system down (P1)' : k === 'P2' ? 'a feature not working (P2)' : 'a question (P3)'}</span><span>{v}</span></div>)}
        {(d.supportEmail || d.supportPhone) && <div className="kv"><span className="k">Contact</span><span>{[d.supportEmail, d.supportPhone].filter(Boolean).join(' · ')}</span></div>}
        {d.credits && <p>{d.credits}</p>}
      </>}
    </Shell>
  );
}
export function PrivacyNoticePage() {
  const [lang] = useLang();
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/public/privacy-notice?lang=${lang}`).then((r) => setD(r.data)).catch(() => setD(null)); }, [lang]);
  return (
    <Shell title={t('Privacy notice')}>
      {d ? <><p style={{ whiteSpace: 'pre-wrap' }}>{d.text}</p><div className="small-muted">Version {d.version}</div></> : <div className="small-muted">{t('Loading…')}</div>}
    </Shell>
  );
}

// /verify/:token - the candidate proves the phone / e-mail on their profile with a one-time code (15.14)
export function VerifyPage() {
  const { token } = useParams();
  useLang();
  const [v, setV] = useState(null); const [fatal, setFatal] = useState(''); const [code, setCode] = useState({}); const [msg, setMsg] = useState(null);
  const load = useCallback(() => api.get(`/public/verify/${token}`).then((r) => setV(r.data)).catch((e) => setFatal(say(e, t('This link does not work. Ask your recruiter for a new one.')))), [token]);
  useEffect(() => { load(); }, [load]);
  const send = (ch) => api.post(`/public/verify/${token}/send`, { channel: ch }).then((r) => setMsg({ ok: true, text: r.data.message })).catch((e) => setMsg({ ok: false, text: say(e, 'Could not send.') }));
  const check = (ch) => api.post(`/public/verify/${token}/check`, { channel: ch, code: code[ch] }).then(() => { setMsg({ ok: true, text: 'Verified. Thank you.' }); load(); }).catch((e) => setMsg({ ok: false, text: say(e, 'That code is not right.') }));
  if (fatal) return <Shell title="TeamLink"><div className="notice red" role="alert">{fatal}</div></Shell>;
  if (!v) return <Shell title="TeamLink"><div className="small-muted">{t('Loading…')}</div></Shell>;
  return (
    <Shell title={t('Welcome, {name}!', { name: v.firstName })}>
      <p>Please confirm that this phone number and e-mail are yours. We send a 6-digit code; type it here.</p>
      {msg && <div className={`notice ${msg.ok ? 'green' : 'red'}`}>{msg.text}</div>}
      {v.channels.map((c) => (
        <div key={c.channel} className="agr-card" style={{ marginBottom: 10 }}>
          <b>{c.channel === 'phone' ? 'Phone' : 'E-mail'}: {c.to}</b> {c.verified && <span className="small-muted">✓ {t('Verified')}</span>}
          {!c.verified && <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={() => send(c.channel)}>Send me a code</button>
            <input inputMode="numeric" maxLength={6} aria-label="Code" placeholder="6-digit code" value={code[c.channel] || ''} onChange={(e) => setCode({ ...code, [c.channel]: e.target.value.replace(/\D/g, '') })} />
            <button type="button" className="btn btn-primary btn-sm" disabled={(code[c.channel] || '').length !== 6} onClick={() => check(c.channel)}>Confirm</button>
          </div>}
        </div>
      ))}
    </Shell>
  );
}
