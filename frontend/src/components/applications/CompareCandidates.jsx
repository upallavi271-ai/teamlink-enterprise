import { useEffect, useState } from 'react';
import api from '../../api';
import Modal from '../Modal.jsx';

// COMPARE CANDIDATES FOR ONE JOB (ATS audit 2026-11-17): 2-4 people picked on a requirement's "People in process" list, side by
// side. Read-only. GET /ats/team-tools/compare?ids=... (the server keeps it inside the login's own list and cuts salary / scores
// for the roles that may not see them, so a missing row below simply says "—").
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);
const yrs = (v) => (v === null || v === undefined || v === '' ? '—' : `${v} yrs`);

function Skills({ m }) {
  if (!m) return '—';
  if (!m.of) return <span className="small-muted">The requirement lists no must-have skills</span>;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <b>{`${m.matched.length} of ${m.of} (${m.pct}%)`}</b>
      {m.matched.length > 0 && <div style={{ fontSize: 12, color: 'var(--green, #15803d)' }}>{`Has: ${m.matched.join(', ')}`}</div>}
      {m.missing.length > 0 && <div style={{ fontSize: 12, color: 'var(--red, #b91c1c)' }}>{`Missing: ${m.missing.join(', ')}`}</div>}
      {m.goodToHave && m.goodToHave.length > 0 && <div className="small-muted" style={{ fontSize: 12 }}>{`Good to have: ${m.goodToHave.join(', ')}`}</div>}
    </div>
  );
}

function Feedback({ f }) {
  if (!f) return <span className="small-muted">No feedback yet</span>;
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <b>{f.rating != null ? `${f.rating} / ${f.outOf}` : 'No rating'}</b>
      <span style={{ fontSize: 12 }}>{[f.recommendation, f.side === 'Client' ? 'Client' : 'Internal', f.round ? `Round ${f.round}` : null].filter(Boolean).join(' · ')}</span>
      <span className="small-muted" style={{ fontSize: 11.5 }}>{[f.by, f.at ? new Date(f.at).toLocaleDateString('en-GB') : null].filter(Boolean).join(' · ')}</span>
    </div>
  );
}

const ROWS = [
  ['Current role', (r) => [r.currentDesignation, r.currentCompany].filter(Boolean).join(' at ') || '—'],
  ['Experience', (r) => (r.relevantExperienceYears != null ? `${yrs(r.experienceYears)} (relevant ${r.relevantExperienceYears} yrs)` : yrs(r.experienceYears))],
  ['Current CTC', (r) => dash(r.currentSalary)],
  ['Expected CTC', (r) => dash(r.expectedSalary)],
  ['Notice period', (r) => dash(r.noticePeriod)],
  ['Location', (r) => (r.preferredLocation && r.preferredLocation !== r.location ? `${dash(r.location)} (prefers ${r.preferredLocation})` : dash(r.location))],
  ['Skills vs the requirement', (r) => <Skills m={r.skillsMatch} />],
  ['Fit score', (r) => (r.matchScore != null ? `${r.matchScore}%` : '—')],
  ['Stage', (r) => (<span>{r.stageLabel || r.stage}{r.interviewRound ? <span className="small-muted">{` · Round ${r.interviewRound}`}</span> : null}</span>)],
  ['Last interview feedback', (r) => <Feedback f={r.lastFeedback} />],
];

export default function CompareCandidates({ ids, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.get('/ats/team-tools/compare', { params: { ids: ids.join(',') } })
      .then((r) => { if (live) setData(r.data); })
      .catch((e) => { if (live) setError(e?.response?.data?.error || 'Could not load the comparison.'); });
    return () => { live = false; };
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const req = data && data.requirement;
  return (
    <Modal title="Compare candidates" size="xwide" note={req ? `${req.reqCode ? `${req.reqCode} · ` : ''}${req.title}` : null} onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <div className="small-muted">Loading…</div>}
      {data && (
        <>
          <div className="small-muted" style={{ marginBottom: 8 }}>
            {[req.skills.length ? `Must-have skills: ${req.skills.join(', ')}` : 'No must-have skills on the requirement', req.experience ? `Experience: ${req.experience}` : null, req.location ? `Location: ${req.location}` : null].filter(Boolean).join(' · ')}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }} />
                  {data.rows.map((r) => <th key={r.applicationId}><a href={`/candidates/${r.candidateId}`}>{r.name}</a></th>)}
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([label, get]) => (
                  <tr key={label}>
                    <td className="cell-muted"><b>{label}</b></td>
                    {data.rows.map((r) => <td key={r.applicationId} style={{ verticalAlign: 'top' }}>{get(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
