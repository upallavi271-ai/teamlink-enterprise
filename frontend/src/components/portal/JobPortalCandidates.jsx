import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import { canSeePortalApplications, canImportPortalApplication } from '../../permissions';
import Pager, { usePaged } from '../Pager.jsx';
import Combo from '../Combo.jsx';
import AtsDataTools from '../AtsDataTools.jsx';

// ---------------------------------------------------------------------------
// JOB PORTAL — the pre-ATS view of Candidates & Pipeline
// (/candidates?view=job-portal).
//
//   Multiple Sources → Job Portal → Resume Score → AI Interview → AI Score →
//   Recruiter Review → SEND TO ATS  (user spec 2026-09-29 §1)
//
// Sub-tabs: All Applications · New · Resume Reviewed · AI Interview Pending ·
// AI Interview Completed · Ready for Recruiter Review · Sent to ATS · Rejected
// (the server names each row's tab — routes/jobPortal.js portalTabOf()).
// Columns: Candidate | Source | Requirement | Resume Score | AI Score | Action.
//
// ONE CANDIDATE SYSTEM. Every row is an Application of a candidate in the
// Candidate Master: the portal ingest (utils/jobPortalBridge.js) and the public
// apply form find an existing candidate by the master's normalised email /
// phone keys (utils/candidateDedupe.js) before creating one. Send to ATS moves
// that same application on (routes/jobPortal.js sendToAts) — no copy is made —
// and from then on it is a row of the ATS Pipeline view.
//
// Permissions: the list needs `requirements / Job Portal Applications / view`
// (Admin / TL / BDE act; Management / Recruiter view — a recruiter can still
// screen and Send to ATS on their own requirements; Accounts: none), the
// screening + Send to ATS buttons `… / create` — and the server's own answer
// (permissions.import, row.mayScreen), which is what it enforces.
// ---------------------------------------------------------------------------

const TABS = [
  ['all', 'All', 'Everyone who applied, in your area'],
  ['new', 'New', 'Just arrived — not checked yet'],
  ['resume_reviewed', 'Resume checked', 'Resume scored — AI interview not sent yet'],
  ['ai_pending', 'AI interview sent', 'Waiting for the AI interview result'],
  ['ai_completed', 'AI interview done', 'Recruiter checks next'],
  ['ready', 'Check by recruiter', 'Send to ATS when ready'],
  ['sent', 'Sent to ATS', 'Now on a job'],
  ['rejected', 'Rejected', 'Not taken forward'],
];

// The one next screening move for a row (the server re-checks every step).
function screeningAction(a) {
  const s = a.screening || {};
  if (a.stage === 'REJECTED' || a.stage === 'HOLD') return null;
  if (!s.duplicateChecked) return { kind: 'duplicate-check', label: 'Run duplicate check' };
  if (!s.resumeScored) return { kind: 'score', label: 'Score resume' };
  if (['NEW', 'AI_INTERVIEW_REQUIRED'].includes(a.stage)) return { kind: 'ai-send', label: 'Send AI interview' };
  if (a.stage === 'AI_INTERVIEW_SCHEDULED') return { kind: 'ai-result', label: 'Record AI score' };
  if (a.stage === 'AI_INTERVIEW_COMPLETED') return { kind: 'review', label: 'Check candidate' };
  if (['RECRUITER_REVIEW', 'RECRUITER_APPROVED'].includes(a.stage)) return { kind: 'send', label: 'Send to ATS' };
  return null;
}

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const pct = (v) => (v == null || v === '' ? '—' : `${v}%`);
const EMPTY_FILTERS = { search: '', department: '', hiring: '' };

export default function JobPortalCandidates({ onSentToAts }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const allowed = canSeePortalApplications(user);
  const mayAct = canImportPortalApplication(user);
  const [apps, setApps] = useState(null);
  const [aiScore, setAiScore] = useState({}); // application id -> typed AI score
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState('all');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const load = useCallback(() => {
    if (!allowed) return;
    api.get('/job-portal/applications')
      .then((r) => { setApps(r.data); })
      .catch((e) => {
        setApps({ applications: [], permissions: { import: false } });
        setError(e.response?.data?.error || 'Could not load the job portal list. Please try again.');
      });
  }, [allowed]);
  useEffect(load, [load]);

  const applications = apps?.applications || [];
  const canImport = mayAct && !!apps?.permissions?.import;

  // One place for every write, so nothing can reject uncaught.
  function run(key, fn, ok, after) {
    setBusy(key); setError(''); setNotice('');
    Promise.resolve(fn())
      .then((r) => { setNotice(ok(r)); load(); if (after) after(r); })
      .catch((e) => setError(e.response?.data?.error || 'That did not work. Please try again.'))
      .finally(() => setBusy(''));
  }

  // One screening step, through its own endpoint (routes/jobPortal.js).
  function screen(a, act) {
    const base = `/job-portal/applications/${a.id}`;
    const call = {
      'duplicate-check': () => api.post(`${base}/duplicate-check`),
      score: () => api.post(`${base}/score`),
      'ai-send': () => api.post(`${base}/ai-interview`, { action: 'send' }),
      'ai-result': () => api.post(`${base}/ai-interview`, { action: 'result', score: aiScore[a.id] }),
      'ai-manual': () => api.post(`${base}/ai-interview`, { action: 'manual' }),
      review: () => api.post(`${base}/review`),
      send: () => api.post(`${base}/send-to-ats`),
    }[act];
    const said = {
      'duplicate-check': (r) => `${a.candidate}: duplicate check — ${r.data.screening?.duplicateResult || 'done'}.`,
      score: (r) => `${a.candidate}: resume scored ${r.data.screening?.resumeScore ?? '—'}%.`,
      'ai-send': () => `${a.candidate}: AI interview marked as sent.`,
      'ai-result': (r) => `${a.candidate}: AI interview score ${r.data.screening?.aiInterviewScore}% recorded.`,
      'ai-manual': () => `${a.candidate}: the recruiter will check them (no AI score).`,
      review: () => `${a.candidate} is ready for your check — send to the ATS when ready.`,
      send: (r) => `Sent. ${a.candidate} is now on the job at ${r.data.stageLabel}.`,
    }[act];
    run(a.id, call, said, act === 'send' ? onSentToAts : undefined);
  }

  const departments = useMemo(
    () => [...new Set(applications.map((a) => a.department).filter(Boolean))].sort(),
    [applications],
  );
  // Search / department / hiring first; the tab counts follow them.
  const narrowed = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return applications.filter((a) => {
      if (q && !`${a.candidate || ''} ${a.email || ''} ${a.phone || ''} ${a.reqCode || ''} ${a.job || ''}`.toLowerCase().includes(q)) return false;
      if (filters.department && a.department !== filters.department) return false;
      if (filters.hiring && a.hiring !== filters.hiring) return false;
      return true;
    });
  }, [applications, filters]);
  const tabCounts = useMemo(() => {
    const out = { all: narrowed.length };
    narrowed.forEach((a) => { out[a.portalTab] = (out[a.portalTab] || 0) + 1; });
    return out;
  }, [narrowed]);
  const filtered = useMemo(() => (tab === 'all' ? narrowed : narrowed.filter((a) => a.portalTab === tab)), [narrowed, tab]);
  const paged = usePaged(filtered);
  const filtersOn = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  // Typing the URL is not access: an Accountant has no Job Portal at all.
  if (!allowed) {
    return (
      <div className="notice red">
        The job portal list is not part of your role.
      </div>
    );
  }

  return (
    <div className="jpc">
      {error && <div className="notice red">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="tabs" style={{ marginBottom: 10 }}>
        {/* Empty tabs are hidden and no tab shows a bare 0 (simplicity checklist #7, #8). */}
        {TABS.filter(([id]) => id === 'all' || id === tab || tabCounts[id] > 0).map(([id, label, hint]) => (
          <div key={id} title={hint} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            {tabCounts[id] ? `${label} (${tabCounts[id].toLocaleString()})` : label}
          </div>
        ))}
      </div>

      <div className="filter-row">
        <input
          type="text"
          placeholder="Search name, phone, email or job…"
          value={filters.search}
          onChange={(e) => setFilter({ search: e.target.value })}
        />
        <Combo value={filters.department} onChange={(e) => setFilter({ department: e.target.value })}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </Combo>
        <Combo value={filters.hiring} onChange={(e) => setFilter({ hiring: e.target.value })}>
          <option value="">Client or internal</option>
          <option value="Client">Client jobs</option>
          <option value="Internal">TeamLink internal</option>
        </Combo>
        <button type="button" className="btn btn-sm" disabled={!filtersOn} onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
        <span style={{ marginLeft: 'auto' }}>
          <AtsDataTools
            module="portal"
            kinds={[]}
            body={() => ({ view: 'applications', ids: filtered.length === applications.length ? null : filtered.map((a) => a.id) })}
          />
        </span>
      </div>

      <div className="tbl-wrap tbl-fit">
        <table>
          <thead>
            <tr>
              <th>Candidate</th><th>Source</th><th>Job</th>
              <th style={{ textAlign: 'right' }}>Resume %</th><th style={{ textAlign: 'right' }}>AI interview %</th><th>Next step</th>
            </tr>
          </thead>
          <tbody>
            {paged.slice.map((a) => (
              <tr key={a.id}>
                <td className="row-link" onClick={() => navigate(`/candidates/${a.candidateId}`)}>
                  <span className="link-btn">{a.candidate}</span>
                  {(a.email || a.phone) && <div className="small-muted">{a.email || a.phone}</div>}
                  <div className="small-muted" style={{ fontSize: 11 }}>{`Applied ${fmt(a.appliedAt)}`}</div>
                </td>
                <td><span className="status new">{a.source}</span></td>
                <td className="cell-muted">
                  {a.reqCode ? `${a.reqCode} · ` : ''}{a.job}
                  <div className="small-muted">{[a.hiring === 'Internal' ? 'TeamLink (internal)' : null, a.department].filter(Boolean).join(' · ')}</div>
                </td>
                <td style={{ textAlign: 'right' }} title={a.screening?.duplicateChecked ? `Duplicate check: ${a.screening.duplicateResult}` : 'Duplicate check not run yet'}>
                  <b>{pct(a.resumeScore)}</b>
                </td>
                <td style={{ textAlign: 'right' }} title="AI interview score — kept apart from client feedback">
                  {a.aiScore != null ? <b>{pct(a.aiScore)}</b> : <span className="small-muted">{a.screening?.aiInterviewStatus === 'Manual Review Requested' ? 'Recruiter will check' : (a.stage === 'AI_INTERVIEW_SCHEDULED' ? 'Sent' : '—')}</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {(() => {
                    if (a.portalTab === 'sent') return <Link className="small-muted" to={`/candidates/${a.candidateId}`}>{`On the job${a.importedAt ? ` · ${fmt(a.importedAt)}` : ''}`}</Link>;
                    if (!canImport || !a.mayScreen) return <span className="small-muted">{`${a.stageLabelWorkflow || a.stageLabel} · view only`}</span>;
                    const next = screeningAction(a);
                    if (!next) return <span className="small-muted">{a.stageLabelWorkflow || a.stageLabel}</span>;
                    if (next.kind === 'ai-result') {
                      return (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type="number" min="0" max="100" placeholder="AI %" aria-label={`AI interview score for ${a.candidate}`}
                            style={{ width: 64 }} value={aiScore[a.id] ?? ''}
                            onChange={(e) => setAiScore((m) => ({ ...m, [a.id]: e.target.value }))}
                          />
                          <button type="button" className="btn btn-sm btn-primary" disabled={busy === a.id || aiScore[a.id] === undefined || aiScore[a.id] === ''} onClick={() => screen(a, 'ai-result')}>Record</button>
                          <button type="button" className="btn btn-sm btn-ghost" disabled={busy === a.id} title="No AI score — the recruiter checks them" onClick={() => screen(a, 'ai-manual')}>Skip AI</button>
                        </span>
                      );
                    }
                    const blocked = next.kind === 'send' && a.screening && !a.screening.readyToSend;
                    return (
                      <button
                        type="button"
                        className={`btn btn-sm${next.kind === 'send' ? ' btn-primary' : ''}`}
                        disabled={busy === a.id || blocked}
                        title={blocked ? (a.screening.blockers || []).join('; ') : ''}
                        onClick={() => screen(a, next.kind)}
                      >
                        {next.label}
                      </button>
                    );
                  })()}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan="6" className="small-muted" style={{ padding: 16 }}>
                {!apps ? 'Loading…' : (applications.length ? 'No one here. Try another tab or clear the filters.' : 'No one has applied on the job portal yet.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={paged} noun="applications" />
      <div className="cell-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        Check each person, then press <strong>Send to ATS</strong> to put them on the job.
      </div>
    </div>
  );
}
