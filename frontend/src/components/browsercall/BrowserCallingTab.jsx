import { useCallback, useEffect, useState } from 'react';
import api from '../../api';
import { mmss, statusWord, PlayButton, CallSummary } from './CallHistory.jsx';
import PhoneLinesSection from './PhoneLinesSection.jsx';
import SimNumbersSection from './SimNumbersSection.jsx';
import AndroidPhonesSection from './AndroidPhonesSection.jsx';
import { useBrowserCall } from './CallProvider.jsx';

const PHONE_WORD = { ready: 'ready: calls back to your SIM ring in this browser', standby: 'another TeamLink tab of this browser takes the calls', connecting: 'connecting…', error: 'could not connect to the phone system (it tries again)', off: 'not connected' };
// the person's own SIM (read-only): their number, and whether this browser is ready to ring
function MySimCard() {
  const { mySim, phoneState } = useBrowserCall();
  if (!mySim) return null;
  return (
    <div className="card section" style={{ marginBottom: 12 }} data-testid="my-sim-card">
      <div className="section-label">Your SIM</div>
      <div>{mySim.routing ? 'Your calling number' : 'Your SIM number'}: <b>{mySim.number}</b>{mySim.operator ? ` (${mySim.operator})` : ''} · port {mySim.portLabel}</div>
      <div className="small-muted">Candidates who call this number back ring here while TeamLink is open: {PHONE_WORD[phoneState] || phoneState}.{mySim.routing ? '' : ' Until an Admin switches on port routing, your outgoing calls may still show another office SIM.'}</div>
    </div>
  );
}

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
    const head = ['Start (IST)', 'Recruiter', 'Candidate', 'Number', 'Line', 'Status', 'Ring sec', 'Talk sec', 'Duration sec', 'Recorded', 'Summary', 'Reason'];
    const lines = rep.calls.map((c) => [c.startAt, c.userName, c.candidateName, c.number, c.lineName || 'Office Synway (SIM)', statusWord(c.status, c.direction), c.ringSec, c.talkSec, c.durationSec, c.hasRecording ? 'Yes' : 'No', c.summaryText, c.hangupReason].map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','));
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }} data-testid="record-switch">
            <b style={{ fontSize: 13 }}>Record calls</b>
            {[true, false].map((on) => <button key={String(on)} type="button" className={`btn btn-sm${cfg.record === on ? ' btn-primary' : ''}`} onClick={() => saveCfg({ record: on })}>{on ? 'On' : 'Off'}</button>)}
            <label className="small-muted">Keep recordings{' '}
              <input type="number" min={1} max={3650} value={cfg.keepDays || 180} style={{ width: 70 }} onChange={(e) => setCfg({ ...cfg, keepDays: e.target.value })} onBlur={() => saveCfg({ keepDays: Number(cfg.keepDays) })} aria-label="Keep recordings for days" /> days
            </label>
          </div>
          <div className="small-muted" style={{ marginTop: 4 }}>Recording is silent: no beep and no message is played to either side. Only the answered part is recorded. After the call TeamLink writes what was said and a short summary into the call history. Audio and the full text are deleted after the days above; the summary and the talk time stay.</div>
          {msg && <div className="small-muted">{msg}</div>}
        </div>
      )}
      <MySimCard />
      {cfg && <AndroidPhonesSection />}
      {cfg && <SimNumbersSection />}
      {cfg && <PhoneLinesSection testNumbers={String(cfg.testNumbers || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10)} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="btn" onClick={csv} disabled={!rep || !rep.calls.length}>Download CSV</button>
      </div>
      {err && <div className="notice red">{err}</div>}
      {rep && (
        <>
          {rep.missed && (rep.missed.length > 0 || rep.missedScope !== 'own') && (
            <div data-testid="missed-calls">
              <div className="section-label">Missed calls to recruiters&apos; SIMs{rep.missedScope === 'team' ? ' (your team)' : rep.missedScope === 'all' ? ' (everyone)' : ''}</div>
              <table className="table">
                <thead><tr><th>When</th><th>Recruiter</th><th>Caller</th><th>SIM</th><th>Why</th></tr></thead>
                <tbody>
                  {rep.missed.length === 0 && <tr><td colSpan={5} className="small-muted">No missed calls in these dates.</td></tr>}
                  {rep.missed.map((m) => (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>{m.userName}</td>
                      <td>{m.candidateName || 'Unknown caller'} <span className="small-muted">{m.number}</span></td><td>{m.lineName}</td><td className="small-muted">{String(m.reason || '').replace(/^Missed - called back the recruiter's number ?/, '').replace(/^\((.*)\)$/, '$1') || 'Missed'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="section-label">Recruiter-wise</div>
          <table className="table">
            <thead><tr><th>Recruiter</th><th>Total</th><th>Connected</th><th>Failed</th><th>Missed</th><th>Total talk time</th><th>Recorded</th></tr></thead>
            <tbody>
              {rep.recruiters.length === 0 && <tr><td colSpan={7} className="small-muted">No calls in these dates.</td></tr>}
              {rep.recruiters.map((r) => <tr key={r.userId}><td>{r.userName || r.userId}</td><td>{r.total}</td><td>{r.connected}</td><td>{r.failed}</td><td>{r.missed}</td><td>{mmss(r.talkSec)}</td><td>{r.recorded || 0}</td></tr>)}
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
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>When</th><th>Called by</th><th>Candidate</th><th>Line</th><th>Ring</th><th>Talk</th><th>Result</th><th>Recording</th><th>What was said</th></tr></thead>
              <tbody>{rep.calls.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(c.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>{c.userName}</td><td>{c.candidateName || c.candidateId}</td><td>{c.lineName || 'Office Synway (SIM)'}</td>
                  <td>{mmss(c.ringSec)}</td><td>{mmss(c.talkSec)}</td><td>{statusWord(c.status, c.direction)}{c.hangupReason && c.status !== 'completed' ? <div className="small-muted">{c.hangupReason}</div> : null}</td>
                  <td><PlayButton call={c} /></td><td style={{ minWidth: 220 }}><CallSummary call={c} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
