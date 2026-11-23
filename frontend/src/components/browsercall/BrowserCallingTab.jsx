import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { mmss, statusWord } from './CallHistory.jsx';
import PhoneLinesSection from './PhoneLinesSection.jsx';

const ist = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const errOf = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d;

// Omni-Channel > AI Voice > "Browser calling": recruiter-wise report (real calls only) + the Admin's switch. Separate from the AI calling tabs.
export default function BrowserCallingTab() {
  const [status, setStatus] = useState(null);
  const [from, setFrom] = useState(ist(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(ist(new Date()));
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { api.get('/browser-calling/report', { params: { from, to } }).then((r) => { setRep(r.data); setErr(''); }).catch((e) => setErr(errOf(e, 'Could not load the report.'))); }, [from, to]);
  useEffect(() => { api.get('/browser-calling/status').then((r) => { setStatus(r.data); if (r.data.isAdmin) api.get('/browser-calling/admin/config').then((c) => setCfg(c.data)).catch(() => {}); }).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const saveCfg = async (patch) => { try { const r = await api.put('/browser-calling/admin/config', { ...cfg, ...patch }); setCfg((c) => ({ ...c, ...r.data })); setMsg('Saved.'); api.get('/browser-calling/status').then((s) => setStatus(s.data)); load(); } catch (e) { setMsg(errOf(e, 'Could not save.')); } };
  const csv = () => {
    if (!rep) return;
    const head = ['Start (IST)', 'Recruiter', 'Candidate', 'Number', 'Line', 'Status', 'Talk sec', 'Duration sec', 'Reason'];
    const lines = rep.calls.map((c) => [c.startAt, c.userName, c.candidateName, c.number, c.lineName || 'Office Synway (SIM)', statusWord(c.status), c.talkSec, c.durationSec, c.hangupReason].map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `browser-calls-${from}-${to}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div>
      <div className="notice">Recruiters call candidates from the <b>Call</b> button in the Candidate List and the Candidate Profile. Audio runs in the browser to the phone line picked in &quot;Call using&quot; (the office SIM line unless an Admin added more below). This is separate from the AI calling.</div>
      {status && !status.canCall && <div className="notice amber">{status.reason}</div>}
      {status && status.testMode && <div className="notice amber">Test mode: only the Admin&apos;s test numbers can be called.</div>}
      {cfg && (
        <div className="card section" style={{ marginBottom: 12 }}>
          <div className="section-label">Admin switch</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {['Off', 'Test', 'Live'].map((m) => <button key={m} type="button" className={`btn btn-sm${cfg.mode === m ? ' btn-primary' : ''}`} onClick={() => saveCfg({ mode: m })}>{m}</button>)}
            <span className="small-muted">Phone system events: {cfg.pbx && cfg.pbx.connected ? 'connected' : `not connected${cfg.pbx && cfg.pbx.error ? ` (${cfg.pbx.error})` : ''}`}</span>
          </div>
          <label className="field" style={{ marginTop: 8 }}>
            <span>Test numbers (10 digits, comma separated)</span>
            <input value={cfg.testNumbers || ''} onChange={(e) => setCfg({ ...cfg, testNumbers: e.target.value })} onBlur={() => saveCfg({ testNumbers: cfg.testNumbers })} />
          </label>
          {msg && <div className="small-muted">{msg}</div>}
        </div>
      )}
      {cfg && <PhoneLinesSection testNumbers={String(cfg.testNumbers || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10)} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="btn" onClick={csv} disabled={!rep || !rep.calls.length}>Download CSV</button>
      </div>
      {err && <div className="notice red">{err}</div>}
      {rep && (
        <>
          <div className="section-label">Recruiter-wise</div>
          <table className="table">
            <thead><tr><th>Recruiter</th><th>Total</th><th>Connected</th><th>Failed</th><th>Missed</th><th>Talk time</th></tr></thead>
            <tbody>
              {rep.recruiters.length === 0 && <tr><td colSpan={6} className="small-muted">No calls in these dates.</td></tr>}
              {rep.recruiters.map((r) => <tr key={r.userId}><td>{r.userName || r.userId}</td><td>{r.total}</td><td>{r.connected}</td><td>{r.failed}</td><td>{r.missed}</td><td>{mmss(r.talkSec)}</td></tr>)}
            </tbody>
          </table>
          {rep.lines && rep.lines.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 14 }}>Line-wise</div>
              <table className="table">
                <thead><tr><th>Line</th><th>Calls</th><th>Connected</th><th>Talk time</th></tr></thead>
                <tbody>{rep.lines.map((r) => <tr key={r.lineName}><td>{r.lineName}</td><td>{r.total}</td><td>{r.connected}</td><td>{mmss(r.talkSec)}</td></tr>)}</tbody>
              </table>
            </>
          )}
          <div className="section-label" style={{ marginTop: 14 }}>Candidate-wise</div>
          <table className="table">
            <thead><tr><th>Candidate</th><th>Calls</th><th>Connected</th><th>Talk time</th><th>Last call</th></tr></thead>
            <tbody>{rep.candidates.map((r) => <tr key={r.candidateId}><td>{r.name || r.candidateId}</td><td>{r.total}</td><td>{r.connected}</td><td>{mmss(r.talkSec)}</td><td>{new Date(r.lastAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>)}</tbody>
          </table>
          <div className="section-label" style={{ marginTop: 14 }}>Every call</div>
          <table className="table">
            <thead><tr><th>When</th><th>Recruiter</th><th>Candidate</th><th>Line</th><th>Status</th><th>Talk</th><th>Reason</th></tr></thead>
            <tbody>{rep.calls.map((c) => <tr key={c.id}><td>{new Date(c.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>{c.userName}</td><td>{c.candidateName || c.candidateId}</td><td>{c.lineName || 'Office Synway (SIM)'}</td><td>{statusWord(c.status)}</td><td>{mmss(c.talkSec)}</td><td className="small-muted">{c.hangupReason || ''}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
