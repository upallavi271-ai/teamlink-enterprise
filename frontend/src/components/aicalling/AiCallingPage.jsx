import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import Combo from '../Combo.jsx';
import AiCallDialog from './AiCallDialog.jsx';
import AiCallDetail from './AiCallDetail.jsx';
import {
  PURPOSES, purposeLabel, statusWord, STATUS_CLASS, when, minutes, errorOf,
} from './aiCallingShared.js';

// AI Calling - a tab inside "Reports & Team" (no new sidebar entry).
//   Call candidates : pick a requirement, tick candidates, pick what the call is for, preview, confirm
//   Calls           : waiting / on the phone / done / failed, cancel and try again, open one call
//   Offers          : "tell them with the AI assistant?" questions waiting for you
//   Numbers         : the dashboard
// The server decides who may do what (roles, your own requirements, consent, hours, limits); this page only shows the reasons.
export default function AiCallingPage() {
  const [tab, setTab] = useState('new');
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/ai-calling/status').then((r) => setStatus(r.data)).catch((e) => setErr(errorOf(e, 'AI calling is not available to this login.')));
  }, []);
  const tabs = [['new', 'Call candidates'], ['calls', 'Calls'], ['offers', 'Offers'], ['numbers', 'Numbers']];
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>AI Calling</h1>
          <div className="page-sub">The AI assistant phones candidates for you: screening, shortlist news, interview time and reminders. Every result is saved on the candidate.</div>
        </div>
      </div>
      {err && <div className="notice red">{err}</div>}
      {status && status.notice && (
        <div className="notice amber">
          {status.notice}
          {status.isAdmin && <> <Link to="/admin/integrations?tab=aicalling">Open the AI Calling settings</Link></>}
          {status.steps && status.steps.length > 0 && <ul style={{ margin: '6px 0 0 18px' }}>{status.steps.map((s) => <li key={s}>{s}</li>)}</ul>}
        </div>
      )}
      {status && status.testMode && <div className="notice amber">Test mode: only the Admin&apos;s test phone numbers are called.</div>}
      {status && !status.canCall && status.canView && <div className="notice">Your role can look at AI calls but not place them.</div>}
      <div className="tabs" style={{ marginBottom: 14 }}>
        {tabs.map(([k, label]) => <div key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</div>)}
      </div>
      {tab === 'new' && <NewCalls status={status} />}
      {tab === 'calls' && <Calls />}
      {tab === 'offers' && <Offers />}
      {tab === 'numbers' && <Numbers />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- Call candidates
function NewCalls({ status }) {
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState('');
  const [purpose, setPurpose] = useState('Screening');
  const [rows, setRows] = useState([]);
  const [picked, setPicked] = useState({});
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { api.get('/ai-calling/jobs').then((r) => setJobs(r.data.rows || [])).catch((e) => setErr(errorOf(e, 'Could not load your requirements.'))); }, []);
  const load = useCallback(() => {
    if (!jobId) { setRows([]); return; }
    setLoading(true);
    api.get('/ai-calling/candidates', { params: { requirementId: jobId, purpose } })
      .then((r) => { setRows(r.data.rows || []); setPicked({}); setErr(''); })
      .catch((e) => setErr(errorOf(e, 'Could not load the candidates.')))
      .finally(() => setLoading(false));
  }, [jobId, purpose]);
  useEffect(load, [load]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => !t || `${r.name} ${r.stageLabel}`.toLowerCase().includes(t));
  }, [rows, q]);
  const ids = Object.keys(picked).filter((k) => picked[k]);
  const callable = shown.filter((r) => r.callable);
  const bulkOk = status && status.canBulk;
  return (
    <div className="panel panel-pad">
      {err && <div className="error-text">{err}</div>}
      <div className="grid-2">
        <div className="field">
          <label>Requirement</label>
          <Combo value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Pick a requirement</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.location ? ` · ${j.location}` : ''}</option>)}
          </Combo>
        </div>
        <div className="field">
          <label>What is the call for</label>
          <Combo value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </Combo>
          <div className="small-muted">{(PURPOSES.find((p) => p.key === purpose) || {}).hint}</div>
        </div>
      </div>
      {jobId && (
        <>
          <div className="row-actions" style={{ margin: '4px 0 8px', alignItems: 'center' }}>
            <input placeholder="Search by name or step" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
            <button className="btn btn-sm" disabled={!bulkOk || !callable.length} onClick={() => setPicked(Object.fromEntries(callable.map((r) => [r.applicationId, true])))}>Tick everyone who can be called</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setPicked({})}>Clear</button>
            <span className="small-muted">{ids.length} ticked</span>
            <button className="btn btn-primary btn-sm" disabled={!ids.length || (ids.length > 1 && !bulkOk)} onClick={() => setDialog(ids)}>
              {ids.length > 1 ? `Call ${ids.length} candidates` : 'Call the ticked candidate'}
            </button>
          </div>
          {ids.length > 1 && !bulkOk && <div className="small-muted">Your role can call one candidate at a time. A team lead can run a campaign.</div>}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th style={{ width: 34 }} /><th>Name</th><th>Phone</th><th>Requirement</th><th>Step</th><th>Can we call?</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.applicationId}>
                    <td><input type="checkbox" disabled={!r.callable} checked={!!picked[r.applicationId]} onChange={(e) => setPicked({ ...picked, [r.applicationId]: e.target.checked })} /></td>
                    <td style={{ whiteSpace: 'normal', minWidth: 140 }}><b>{r.name}</b></td>
                    <td>{r.phone || '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{r.jobTitle}</td>
                    <td>{r.stageLabel}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 170 }}>{r.callable ? <span className="status active">Yes</span> : <span className="small-muted">{r.reason}</span>}</td>
                    <td><button className="btn btn-sm" disabled={!r.callable} onClick={() => setDialog([r.applicationId])}>Call</button></td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={7} className="small-muted">{loading ? 'Loading…' : 'No candidates here.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {dialog && <AiCallDialog applicationIds={dialog} purpose={purpose} onClose={() => setDialog(null)} onDone={load} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- Calls
function Calls() {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ status: '', purpose: '', from: '', to: '' });
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api.get('/ai-calling/calls', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })
      .then((r) => { setRows(r.data.rows || []); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load the calls.')));
  }, [f]);
  useEffect(load, [load]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  async function act(id, path) {
    try { await api.post(`/ai-calling/calls/${id}/${path}`); load(); } catch (e) { setErr(errorOf(e, 'That did not work.')); }
  }
  return (
    <div className="panel panel-pad">
      {err && <div className="error-text">{err}</div>}
      <div className="row-actions" style={{ marginBottom: 10 }}>
        <Combo value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any state</option>
          {['queued', 'calling', 'completed', 'failed', 'busy', 'no-answer', 'cancelled'].map((s) => <option key={s} value={s}>{statusWord(s)}</option>)}
        </Combo>
        <Combo value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
          <option value="">Any purpose</option>
          {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </Combo>
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} title="From" />
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} title="To" />
      </div>
      <div className="tbl-wrap">
        <table>
          <thead><tr><th>Candidate</th><th>Requirement</th><th>For</th><th>State</th><th>Result</th><th>Talked for</th><th>Started by</th><th>When</th><th /></tr></thead>
          <tbody>
            {(rows || []).map((r) => {
              const waiting = r.status === 'queued' || (['busy', 'no-answer', 'failed'].includes(r.status) && r.nextAttemptAt);
              const retry = ['failed', 'busy', 'no-answer'].includes(r.status) && r.attempts < r.maxAttempts;
              return (
                <tr key={r.id} className="row-link" onClick={() => setOpen(r.id)}>
                  <td style={{ whiteSpace: 'normal', minWidth: 130 }}><b>{r.candidateName}</b>{r.mode === 'test' && <span className="small-muted"> (test)</span>}</td>
                  <td style={{ whiteSpace: 'normal' }}>{r.jobTitle}</td>
                  <td>{purposeLabel(r.purpose)}{r.initiatedVia === 'web-link' && <span className="small-muted"> · AI link</span>}{r.initiatedVia === 'sip' && <span className="small-muted"> · AI phone</span>}</td>
                  <td><span className={`status ${STATUS_CLASS[r.status] || 'new'}`}>{statusWord(r.status)}</span></td>
                  <td style={{ whiteSpace: 'normal' }}>{r.outcome || (r.waitReason ? <span className="small-muted">{r.waitReason}</span> : '')}</td>
                  <td>{minutes(r.durationSec)}</td>
                  <td>{r.initiatedByName || r.initiatedVia}</td>
                  <td>{when(r.nextAttemptAt && waiting ? r.nextAttemptAt : (r.startedAt || r.createdAt))}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {waiting && <button className="btn btn-sm btn-danger" onClick={() => act(r.id, 'cancel')}>Cancel</button>}
                    {retry && !waiting && <button className="btn btn-sm" onClick={() => act(r.id, 'retry')}>Try again</button>}
                  </td>
                </tr>
              );
            })}
            {rows && !rows.length && <tr><td colSpan={9} className="small-muted">No AI calls yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <AiCallDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- Offers
function Offers() {
  const [rows, setRows] = useState(null);
  const [dialog, setDialog] = useState(null);
  const load = useCallback(() => { api.get('/ai-calling/offers').then((r) => setRows(r.data.rows || [])).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  return (
    <div className="panel panel-pad">
      <div className="small-muted" style={{ marginBottom: 8 }}>These appear when a candidate is moved to the shortlisted step or an interview is booked or changed. Nothing is called until you confirm.</div>
      {(rows || []).map((o) => (
        <div key={o.id} className="assign-row">
          <span><b>{o.candidateName}</b><br /><span className="small-muted">{`${o.kind === 'shortlist' ? 'Shortlisted' : 'Interview booked or changed'} · ${o.jobTitle} · ${when(o.createdAt)}`}</span></span>
          <span className="row-actions">
            <button className="btn btn-sm btn-primary" onClick={() => setDialog(o)}>Preview and call</button>
            <button className="btn btn-sm" onClick={() => api.post(`/ai-calling/offers/${o.id}/dismiss`).then(load)}>Not now</button>
          </span>
        </div>
      ))}
      {rows && !rows.length && <div className="small-muted">No offers waiting.</div>}
      {dialog && <AiCallDialog applicationIds={[dialog.applicationId]} purpose={dialog.purpose} offerId={dialog.id} onClose={() => setDialog(null)} onDone={load} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- Numbers
function Tile({ n, label }) {
  return (
    <div className="panel panel-pad" style={{ margin: 0, minWidth: 130, flex: '1 1 130px' }}>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{n}</div>
      <div className="small-muted">{label}</div>
    </div>
  );
}
function Numbers() {
  const [d, setD] = useState(null);
  const [f, setF] = useState({ from: '', to: '', purpose: '', mode: 'live' });
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/ai-calling/dashboard', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })
      .then((r) => { setD(r.data); setErr(''); }).catch((e) => setErr(errorOf(e, 'Could not load the numbers.')));
  }, [f]);
  const t = d && d.totals;
  return (
    <div>
      {err && <div className="error-text">{err}</div>}
      <div className="row-actions" style={{ marginBottom: 10 }}>
        <Combo value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
          <option value="live">Real calls</option>
          <option value="test">Test calls</option>
        </Combo>
        <Combo value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>
          <option value="">Any purpose</option>
          {PURPOSES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </Combo>
        <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} title="From" />
        <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} title="To" />
      </div>
      {t && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <Tile n={t.total} label="Calls" /><Tile n={t.connected} label="Connected" /><Tile n={t.failed} label="Failed" />
            <Tile n={t.busy} label="Busy" /><Tile n={t.noAnswer} label="No answer" /><Tile n={minutes(t.averageSeconds) || '0 s'} label="Average length" />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <Tile n={t.interested} label="Interested (screening)" /><Tile n={t.notInterested} label="Not interested" /><Tile n={t.callbackRequests} label="Asked for a call back" />
            <Tile n={t.shortlistCalls} label="Shortlist calls" /><Tile n={t.interviewConfirmed} label="Interviews confirmed" /><Tile n={t.rescheduleRequests} label="Asked to change time" />
          </div>
          {d.campaigns.length > 0 && (
            <div className="panel panel-pad">
              <div className="section-label">Campaigns</div>
              {d.campaigns.map((c) => <div key={c.id} className="assign-row"><b>{c.name}</b><span className="small-muted">{`${c.total} calls · ${c.completed} connected · ${c.interested} interested`}</span></div>)}
            </div>
          )}
          {d.note && <div className="small-muted">{d.note}</div>}
        </>
      )}
    </div>
  );
}
