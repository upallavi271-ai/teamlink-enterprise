import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api';
import Combo from '../Combo.jsx';
import { when, errorOf } from './aiCallingShared.js';

// KAVYA - the Telugu / Hindi / English AI caller on our own server (a tab of AI Calling).
//   Give to Kavya : pick a requirement, tick candidates, Kavya phones them (same roles, consent, DND and test-number rules as AI Calling)
//   Runs          : what Kavya has finished so far - outcome, language, the interview time the candidate asked for, why not interested, area + distance
// The server decides who may do what; this page only shows the reasons. Kavya keeps her own calling hours (9 am - 6 pm).
const RUN_WORD = { draft: 'Saved', preparing: 'Getting ready', running: 'Calling', paused: 'Paused', completed: 'Finished' };
const OUTCOME_WORD = {
  interested: 'Interested', not_interested: 'Not interested', not_relevant: 'Not relevant', no_answer_from_caller: 'No answer', wants_other_opening: 'Wants another opening',
  callback: 'Call back', no_clear_response: 'No clear response', keep_profile: 'Keep profile', wants_higher_package: 'Wants higher package',
};
const outcomeWord = (o) => OUTCOME_WORD[o] || String(o || '—').replace(/_/g, ' ');
const LANG_WORD = { te: 'Telugu', hi: 'Hindi', en: 'English' };

export default function KavyaTab() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [openRun, setOpenRun] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api.get('/kavya/status').then((r) => setStatus(r.data)).catch((e) => setErr(errorOf(e, 'Kavya is not available to this login.'))); }, []);
  return (
    <div>
      {err && <div className="notice red">{err}</div>}
      {status && !status.configured && <div className="notice amber">Kavya is not connected on this server yet.</div>}
      {status && status.configured && !status.reachable && <div className="notice amber">Kavya does not answer right now{status.problem ? `: ${status.problem}` : ''}.</div>}
      {status && status.mode === 'Off' && <div className="notice amber">AI calling is switched off, so nobody is handed to Kavya. An Admin turns it on in Administration &gt; Integrations &gt; AI Calling.</div>}
      {status && status.testMode && <div className="notice amber">Test mode: only the Admin&apos;s test phone numbers are called.</div>}
      {status && !status.canCall && <div className="notice">Your role can look at Kavya&apos;s runs but not hand candidates to her.</div>}
      <GiveToKavya status={status} onStarted={(id) => { setTick((t) => t + 1); setOpenRun(id); }} />
      <Runs tick={tick} openRun={openRun} setOpenRun={setOpenRun} />
    </div>
  );
}

function GiveToKavya({ status, onStarted }) {
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState('');
  const [rows, setRows] = useState([]);
  const [picked, setPicked] = useState({});
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [langs, setLangs] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/ai-calling/jobs').then((r) => setJobs(r.data.rows || [])).catch((e) => setErr(errorOf(e, 'Could not load your requirements.'))); }, []);
  const load = useCallback(() => {
    if (!jobId) { setRows([]); return; }
    api.get('/ai-calling/candidates', { params: { requirementId: jobId, purpose: 'Screening' } })
      .then((r) => { setRows(r.data.rows || []); setPicked({}); setErr(''); })
      .catch((e) => setErr(errorOf(e, 'Could not load the candidates.')));
  }, [jobId]);
  useEffect(load, [load]);
  const shown = useMemo(() => { const t = q.trim().toLowerCase(); return rows.filter((r) => !t || `${r.name} ${r.stageLabel}`.toLowerCase().includes(t)); }, [rows, q]);
  const ids = Object.keys(picked).filter((k) => picked[k]);
  const callable = shown.filter((r) => r.callable);
  const canGive = status && status.canCall && status.configured && status.mode !== 'Off';
  const bulkOk = status && status.canBulk;
  async function give() {
    if (!ids.length || busy) return;
    if (!window.confirm(`Give ${ids.length} candidate${ids.length > 1 ? 's' : ''} to Kavya? She will phone them (Telugu / Hindi / English) between 9 am and 6 pm.`)) return;
    setBusy(true); setMsg(null); setErr('');
    try {
      const r = await api.post('/kavya/runs', { applicationIds: ids, source: 'ats', extras: { interviewMode: mode, languagesRequired: langs } });
      setMsg(`${r.data.started} candidate(s) given to Kavya.${r.data.skipped && r.data.skipped.length ? ` ${r.data.skipped.length} skipped: ${r.data.skipped.slice(0, 3).map((s) => `${s.name || 'someone'} (${s.reason})`).join('; ')}` : ''}${r.data.note ? ` ${r.data.note}` : ''}`);
      setPicked({}); load(); onStarted(r.data.id);
    } catch (e) {
      const sk = e.response && e.response.data && e.response.data.skipped;
      setErr(`${errorOf(e, 'Kavya could not start.')}${sk && sk.length ? ` ${sk.slice(0, 3).map((s) => `${s.name || 'someone'}: ${s.reason}`).join('; ')}` : ''}`);
    } finally { setBusy(false); }
  }
  return (
    <div className="panel panel-pad" style={{ marginBottom: 14 }}>
      <h3 style={{ marginTop: 0 }}>Give candidates to Kavya</h3>
      {err && <div className="error-text">{err}</div>}
      {msg && <div className="notice green">{msg}</div>}
      <div className="grid-2">
        <div className="field">
          <label>Requirement</label>
          <Combo value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Pick a requirement</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.location ? ` · ${j.location}` : ''}</option>)}
          </Combo>
          <div className="small-muted">Kavya tells the candidate the role, place, experience, salary and what the requirement says about education, notice and joining.</div>
        </div>
        <div className="field">
          <label>Interview mode (optional)</label>
          <Combo value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">Not said</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="online or offline">Online or offline</option>
          </Combo>
          <label style={{ marginTop: 8 }}>Languages the job needs (optional)</label>
          <input value={langs} onChange={(e) => setLangs(e.target.value)} placeholder="Telugu and English" maxLength={80} />
        </div>
      </div>
      {jobId && (
        <>
          <div className="row-actions" style={{ margin: '4px 0 8px', alignItems: 'center' }}>
            <input placeholder="Search by name or step" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
            <button className="btn btn-sm" disabled={!bulkOk || !callable.length} onClick={() => setPicked(Object.fromEntries(callable.map((r) => [r.applicationId, true])))}>Tick everyone who can be called</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setPicked({})}>Clear</button>
            <span className="small-muted">{ids.length} ticked</span>
            <button className="btn btn-primary btn-sm" disabled={!canGive || !ids.length || busy || (ids.length > 1 && !bulkOk)} onClick={give}>
              {busy ? 'Starting…' : `Give ${ids.length || ''} to Kavya`}
            </button>
          </div>
          {ids.length > 1 && !bulkOk && <div className="small-muted">Your role can hand over one candidate at a time. A team lead can hand over many.</div>}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th style={{ width: 34 }} /><th>Name</th><th>Phone</th><th>Step</th><th>Can we call?</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.applicationId}>
                    <td><input type="checkbox" disabled={!r.callable} checked={!!picked[r.applicationId]} onChange={(e) => setPicked({ ...picked, [r.applicationId]: e.target.checked })} /></td>
                    <td style={{ whiteSpace: 'normal', minWidth: 140 }}><b>{r.name}</b></td>
                    <td>{r.phone || '—'}</td>
                    <td>{r.stageLabel}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 170 }}>{r.callable ? <span className="status active">Yes</span> : <span className="small-muted">{r.reason}</span>}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={5} className="small-muted">No candidates here.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Runs({ tick, openRun, setOpenRun }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get('/kavya/runs').then((r) => { setRuns(r.data.runs || []); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load Kavya runs.')));
  }, []);
  useEffect(load, [load, tick]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  return (
    <div className="panel panel-pad">
      <h3 style={{ marginTop: 0 }}>Kavya runs</h3>
      {err && <div className="error-text">{err}</div>}
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Requirement</th><th>State</th><th>Phoned</th><th>Results</th><th>Started by</th><th>When</th><th /></tr></thead>
          <tbody>
            {(runs || []).map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'normal', minWidth: 160 }}><b>{r.title}</b>{r.note ? <div className="small-muted">{r.note}</div> : null}</td>
                <td>{RUN_WORD[r.status] || r.status}</td>
                <td>{r.called} / {r.total}</td>
                <td style={{ whiteSpace: 'normal' }}>{Object.entries(r.outcomes || {}).map(([k, n]) => `${outcomeWord(k)} ${n}`).join(' · ') || '—'}</td>
                <td>{r.createdByName || '—'}</td>
                <td>{when(r.createdAt)}</td>
                <td><button className="btn btn-sm" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>{openRun === r.id ? 'Close' : 'Open'}</button></td>
              </tr>
            ))}
            {runs && !runs.length && <tr><td colSpan={7} className="small-muted">Nothing has been given to Kavya yet.</td></tr>}
            {!runs && <tr><td colSpan={7} className="small-muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {openRun && <RunDetail id={openRun} onChanged={load} />}
    </div>
  );
}

function RunDetail({ id, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get(`/kavya/runs/${id}`).then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load this run.')));
  }, [id]);
  useEffect(() => { setD(null); load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  async function act(a) {
    try { await api.post(`/kavya/runs/${id}/${a}`); load(); onChanged(); } catch (e) { setErr(errorOf(e, 'That did not work.')); }
  }
  const run = d && d.run;
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border, #ddd)', paddingTop: 12 }}>
      {err && <div className="error-text">{err}</div>}
      {run && (
        <>
          <div className="row-actions" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b>{run.title}</b>
            <span className="small-muted">{RUN_WORD[run.status] || run.status} · {run.called} of {run.total} phoned</span>
            {['running', 'preparing'].includes(run.status) && <button className="btn btn-sm" onClick={() => act('pause')}>Pause</button>}
            {run.status === 'paused' && <button className="btn btn-sm btn-primary" onClick={() => act('start')}>Resume</button>}
            <button className="btn btn-sm btn-ghost" onClick={load}>Refresh</button>
          </div>
          {run.skipped && run.skipped.length > 0 && (
            <div className="small-muted" style={{ marginBottom: 8 }}>Not handed over: {run.skipped.map((s) => `${s.name || 'someone'} (${s.reason})`).join('; ')}</div>
          )}
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Name</th><th>Phone</th><th>Result</th><th>Language</th><th>Seconds</th><th>Interview time asked</th><th>Why not</th><th>Stays in</th></tr></thead>
              <tbody>
                {(d.calls || []).map((c) => (
                  <tr key={c.id}>
                    <td style={{ whiteSpace: 'normal', minWidth: 120 }}><b>{c.name || '—'}</b></td>
                    <td>{c.phone}</td>
                    <td>{outcomeWord(c.outcome)}</td>
                    <td>{LANG_WORD[c.language] || c.language || '—'}</td>
                    <td>{c.seconds != null ? c.seconds : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{c.slot || '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{c.reasonType ? `${c.reasonType}${c.reason ? `: ${c.reason}` : ''}` : (c.reason || '—')}</td>
                    <td style={{ whiteSpace: 'normal' }}>{c.area ? `${c.area}${c.distanceKm !== '' && c.distanceKm != null ? ` (${c.distanceKm} km)` : ''}` : '—'}</td>
                  </tr>
                ))}
                {d.waiting && d.waiting.map((w) => (
                  <tr key={w.applicationId}><td style={{ whiteSpace: 'normal' }}>{w.name}</td><td colSpan={7} className="small-muted">Waiting for Kavya&apos;s call</td></tr>
                ))}
                {!(d.calls || []).length && !(d.waiting || []).length && <tr><td colSpan={8} className="small-muted">No calls yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="small-muted" style={{ marginTop: 6 }}>Each finished call is also written on the candidate&apos;s timeline. A call never changes a stage or an interview — you do that.</div>
        </>
      )}
      {!run && !err && <div className="small-muted">Loading…</div>}
    </div>
  );
}
