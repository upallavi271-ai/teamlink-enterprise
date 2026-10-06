import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import StatusChip from '../../components/ui/StatusChip.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import '../../components/CandidateDrawer.css';
import './Team.css';

// ---------------------------------------------------------------------------
// RECRUITER 360 / BDE 360 / TL 360 — the side panel Recruiter & BDE opens when
// a name is clicked (the user's spec, 2026-09-29):
//
//   Recruiter 360  Overview · Requirements · Candidates · Interviews ·
//                  Pending Actions · Activity
//                  Open Requirements · Active Candidates · Pending Actions ·
//                  Interviews Today · Selected · Joined
//   BDE 360        Clients · Requirements · Candidate Submissions · Client
//                  Feedback · Interviews · Selections · Joining · Pending
//                  Actions · Activity
//                  Clients · Open Requirements · Submitted Candidates ·
//                  Feedback Pending · Interviews · Selected · Joined
//   TL 360         Team · Recruiters · Requirements · Candidates · Pending
//                  Reviews · Interviews · Selections · Activity
//
// EVERY NUMBER OPENS THE EXACT LIST IT COUNTS (metricLink): the server counts
// a set and returns that same set's rows (GET /api/ats/team/:id?metric=).
// Data: GET /api/ats/team/:userId — scope-checked on the server (a TL opening
// a recruiter outside their team gets 403, shown here as a plain message).
// ---------------------------------------------------------------------------
// (Pending Reviews — the TL Review step only — opens its own list.)
const ACTION_METRICS = ['needsAction', 'clientActions'];
// Where a number goes. Action counts open Pending Actions for that owner;
// everything else the exact list behind the number.
export function metricLink(personId, metric) {
  if (ACTION_METRICS.includes(metric)) return `/ats/team?view=pending&owner=${encodeURIComponent(`id:${personId}`)}`;
  return `/ats/team?view=list&person=${encodeURIComponent(personId)}&metric=${encodeURIComponent(metric)}`;
}

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
const dayTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const DUE = { overdue: ['🔴 Late', 'red'], today: ['🟠 Due today', 'amber'], upcoming: ['🔵 Upcoming', 'blue'] };

function Section({ title, count, to, children }) {
  return (
    <section className="cdw-card r360-sec">
      <div className="cdw-label r360-sec-head">
        <span>{title}{count != null ? ` (${fmt(count)})` : ''}</span>
        {to && count > 0 && <Link to={to} className="r360-all">{`All ${fmt(count)} →`}</Link>}
      </div>
      {children}
    </section>
  );
}

// The preview rows of one section, by what the list holds.
function Rows({ sec, empty }) {
  const rows = sec.rows || [];
  if (!rows.length) return <EmptyState compact icon="🗂️" title={empty} />;
  return (
    <div className="r360-list">
      {rows.map((r) => {
        if (sec.kind === 'requirements') {
          return (
            <div key={r.id} className="r360-row">
              <div style={{ minWidth: 0 }}>
                <Link to={`/requirements/${r.id}`} className="r360-strong">{r.title}</Link>
                <div className="small-muted r360-ellipsis">{[r.reqCode, r.client, r.section].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="r360-right"><StatusChip status={r.live ? 'Open' : 'Closed'}>{r.statusLabel}</StatusChip></div>
            </div>
          );
        }
        if (sec.kind === 'clients') {
          return (
            <div key={r.id} className="r360-row">
              {r.link ? <Link to={`/clients/${r.id}`} className="r360-strong">{r.name}</Link> : <b>{r.name}</b>}
              <span className="small-muted">{`${fmt(r.openRequirements)} open of ${fmt(r.requirements)} jobs`}</span>
            </div>
          );
        }
        if (sec.kind === 'people') {
          return (
            <div key={r.id} className="r360-row">
              <div style={{ minWidth: 0 }}>
                <b>{r.name}</b>
                <div className="small-muted r360-ellipsis">{[r.seatLabel, r.status === 'Left' ? 'Left' : null].filter(Boolean).join(' · ')}</div>
              </div>
              <span className="small-muted">{`${fmt(r.counts.activeCandidates)} active · ${fmt(r.counts.needsAction)} to act`}</span>
            </div>
          );
        }
        if (sec.kind === 'actions') {
          const due = DUE[r.dueStatus];
          return (
            <div key={r.id} className="r360-row">
              <div style={{ minWidth: 0 }}>
                <Link to={`/candidates/${r.candidateId}`} className="r360-strong">{r.candidate}</Link>
                <div className="small-muted r360-ellipsis">{[r.requirement, r.client, r.stageLabel].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="r360-right">
                <StatusChip status={r.action}>{r.action}</StatusChip>
                {due && <StatusChip tone={due[1]}>{due[0]}</StatusChip>}
              </div>
            </div>
          );
        }
        // applications / joined
        return (
          <div key={r.id} className="r360-row">
            <div style={{ minWidth: 0 }}>
              <Link to={`/candidates/${r.candidateId}`} className="r360-strong">{r.candidate}</Link>
              <div className="small-muted r360-ellipsis">{[r.requirement, r.client].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="r360-right">
              {r.interviewAt && ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'].includes(r.stage) && <span className="small-muted">{dayTime(r.interviewAt)}</span>}
              <StatusChip status={r.stageLabel}>{r.stageLabel}</StatusChip>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const EMPTY_TEXT = {
  requirements: 'No open jobs in your area.',
  candidates: 'No people in process.',
  interviews: 'No interviews right now.',
  pending: 'Nothing is waiting on this person.',
  clients: 'No clients yet. Set them as client manager on Clients.',
  submissions: 'No one sent to their clients yet.',
  feedback: 'Nothing waiting for the client.',
  selections: 'Nobody selected right now.',
  joining: 'No joinings.',
  recruiters: 'No recruiters in this team yet.',
  reviews: 'No reviews waiting.',
};

export default function Recruiter360({ personId, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setD(null);
    setError('');
    api.get(`/ats/team/${encodeURIComponent(personId)}`)
      .then((r) => setD(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not open this person. Please try again.'));
  }, [personId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = d && d.person;
  const role = p && p.roleGroup;
  const link = (m) => (p ? metricLink(p.id, m) : null);

  return (
    <div className="cdw-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="cdw r360" role="dialog" aria-label={p ? `${p.roleLabel} 360` : '360'}>
        <div className="cdw-head">
          <div style={{ minWidth: 0 }}>
            <div className="cdw-name">{p ? p.name : 'Loading…'}</div>
            {p && (
              <div className="cdw-contact">
                <span className="small-muted">{`${p.roleLabel} 360`}</span>
                {p.employeeCode && <span>{`Employee ID ${p.employeeCode}`}</span>}
                {p.seat && <span title="Recruiter Code / seat">{p.seat}</span>}
                <StatusChip status={p.status === 'Left' ? 'Inactive' : 'Active'}>{p.status || 'Active'}</StatusChip>
              </div>
            )}
          </div>
          <button type="button" className="cdw-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error && <div className="notice red" style={{ margin: '10px 16px' }}>{error}</div>}
        {!d && !error && <div className="small-muted" style={{ padding: 16 }}>Loading…</div>}

        {d && (
          <div className="cdw-body">
            {/* --- Overview: who they are + the numbers, each opening its list --- */}
            <Section title={role === 'TL' ? 'Team' : 'Overview'}>
              <div className="c360-own is-compact" style={{ marginBottom: 10 }}>
                {[['Department', p.department], ['Section', p.section], ...(role === 'TL' ? [] : [['TL', p.tl]]),
                  ['Designation', p.designation], ['Employee ID', p.employeeCode], ['Seat', p.seat]].map(([k, v]) => (
                    <div key={k} className="c360-own-item"><span>{k}</span><b title={v || ''}>{v || '—'}</b></div>
                ))}
              </div>
              {role === 'TL' && d.team && (
                <div className="small-muted" style={{ marginBottom: 8 }}>
                  {`${fmt(d.team.size)} recruiter(s) · ${fmt(d.team.active)} active${d.team.sections.length ? ` · ${d.team.sections.join(', ')}` : ''}`}
                </div>
              )}
              <div className="r360-tiles">
                {d.numbers.map((n) => (
                  <div key={n.metric} className="r360-tile" title={n.hint || ''}>
                    <div className="small-muted">{n.label}</div>
                    {n.value > 0
                      ? <Link to={link(n.metric)} className="r360-n">{fmt(n.value)}</Link>
                      : <b className="r360-n is-zero">{fmt(n.value)}</b>}
                  </div>
                ))}
              </div>
              {d.bdeEmpty && (
                <div className="notice r360-note">
                  No clients yet. Set them as client manager on Clients and the numbers fill in.
                </div>
              )}
            </Section>

            {d.sections.map((sec) => (
              <Section key={sec.id} title={sec.title} count={sec.total} to={link(sec.metric)}>
                <Rows sec={sec} empty={EMPTY_TEXT[sec.id] || 'Nothing here.'} />
              </Section>
            ))}

            {/* --- Activity --- */}
            <Section title="Activity">
              {d.activity.length
                ? (
                  <div className="c360-activity">
                    {d.activity.map((a, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div key={i} className="cdw-tl">
                        <span className="cdw-tl-dot" />
                        <div style={{ minWidth: 0 }}>
                          <div>
                            {a.what}
                            {a.candidate && <> · {a.candidateId ? <Link to={`/candidates/${a.candidateId}`}>{a.candidate}</Link> : a.candidate}</>}
                          </div>
                          <div className="small-muted">{[dayTime(a.when), a.requirement].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
                : <EmptyState compact icon="🕘" title="No activity recorded on records you can see." />}
            </Section>
          </div>
        )}
      </aside>
    </div>
  );
}
